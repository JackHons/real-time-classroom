import { randomUUID } from 'node:crypto';
import { normalizeStudentNumber } from '../domain/normalization.js';
import type { Class, ClassId, IsoUtc, PendingStudentRequest, PendingStudentRequestId, StudentId } from '../domain/types.js';
import type { ClassRosterRepository, ClassSummary, CsvIssue, CsvPreview, JoinResult, RosterEntry, TeacherAuthorization } from './types.js';

export type ClassServiceDependencies = Readonly<{
  repository: ClassRosterRepository;
  teacherAuthorization: TeacherAuthorization;
  now?: () => string;
  createClassId?: () => ClassId;
  createStudentId?: () => StudentId;
  createPendingRequestId?: () => PendingStudentRequestId;
  /** Best-effort invalidation only; it contains no roster or student data. */
  notify?: (event: Readonly<{ classId: ClassId; resourceType: 'pending' | 'roster'; id: string; event: string; audience: 'teacher' }>) => void;
  onClassDeleted?: (classId: ClassId) => void;
}>;

export class ClassService {
  private readonly now: () => string;
  private readonly createClassId: () => ClassId;
  private readonly createStudentId: () => StudentId;
  private readonly createPendingRequestId: () => PendingStudentRequestId;

  constructor(private readonly dependencies: ClassServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createClassId = dependencies.createClassId ?? (() => randomUUID() as ClassId);
    this.createStudentId = dependencies.createStudentId ?? (() => randomUUID() as StudentId);
    this.createPendingRequestId = dependencies.createPendingRequestId ?? (() => randomUUID() as PendingStudentRequestId);
  }

  listPublicClasses(): readonly ClassSummary[] {
    return this.dependencies.repository.listClasses();
  }

  createClass(teacherContext: unknown, name: string): Class {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    const normalizedName = normalizeText(name);
    if (normalizedName.length === 0) throw new Error('CLASS_NAME_REQUIRED');
    const now = this.now() as IsoUtc;
    const classroom: Class = { id: this.createClassId(), name: normalizedName, createdAtUtc: now, updatedAtUtc: now };
    this.dependencies.repository.createClass(classroom);
    return classroom;
  }

  deleteClass(teacherContext: unknown, classId: ClassId, confirmation: Readonly<{ confirmed: boolean; impactAcknowledged: boolean }>): void {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    if (!confirmation.confirmed || !confirmation.impactAcknowledged) throw new Error('CLASS_DELETE_CONFIRMATION_REQUIRED');
    this.dependencies.repository.deleteClass(classId);
    this.notify({ classId, resourceType: 'roster', id: classId, event: 'class_deleted', audience: 'teacher' });
    try { this.dependencies.onClassDeleted?.(classId); } catch { /* durable delete wins */ }
  }

  previewRosterCsv(csv: string): CsvPreview {
    return this.rosterCsvPreview(csv).preview;
  }

  private rosterCsvPreview(csv: string): Readonly<{ preview: CsvPreview; rowLines: readonly number[] }> {
    const parsed = parseCsv(csv);
    if (parsed.issues.length > 0) return { preview: { rows: [], issues: parsed.issues }, rowLines: [] };
    const rows = parsed.rows;
    const issues: CsvIssue[] = [];
    const output: RosterEntry[] = [];
    const rowLines: number[] = [];
    const seenNumbers = new Set<string>();
    for (const row of rows) {
      const line = row.line;
      const displayName = normalizeText(row.fields[0] ?? '');
      const rawStudentNumber = normalizeText(row.fields[1] ?? '');
      const normalizedStudentNumber = normalizeStudentNumber(rawStudentNumber);
      if (displayName.length === 0) issues.push({ line, message: '姓名不可為空白' });
      if (normalizedStudentNumber.length === 0) issues.push({ line, message: '學號不可為空白' });
      if (row.fields.length < 2) issues.push({ line, message: '每列必須包含學號及姓名兩欄' });
      if (normalizedStudentNumber.length > 0 && seenNumbers.has(normalizedStudentNumber)) issues.push({ line, message: 'CSV 內學號重複' });
      seenNumbers.add(normalizedStudentNumber);
      output.push({ displayName, rawStudentNumber, normalizedStudentNumber });
      rowLines.push(line);
    }
    if (rows.length === 0) issues.push({ line: 1, message: 'CSV 不可沒有名單資料' });
    const ignored = parsed.ignoredColumnLines;
    return { preview: { rows: output, issues, ...(ignored.length === 0 ? {} : { ignoredColumnLines: ignored }) }, rowLines };
  }

  importRosterCsv(teacherContext: unknown, classId: ClassId, csv: string): CsvPreview {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    const { preview, rowLines } = this.rosterCsvPreview(csv);
    if (preview.issues.length > 0) return preview;
    if (!this.dependencies.repository.classExists(classId)) return { ...preview, issues: [{ line: 1, message: '班級不存在' }] };
    const existingIssues = preview.rows.flatMap((entry, index) => this.dependencies.repository.hasStudentNumber(classId, entry.normalizedStudentNumber)
      ? [{ line: rowLines[index] ?? 1, message: '學號已存在於班級名單' }]
      : []);
    if (existingIssues.length > 0) return { ...preview, issues: existingIssues };
    try {
      this.dependencies.repository.importRoster(classId, preview.rows, this.createStudentId, this.now());
      this.notify({ classId, resourceType: 'roster', id: classId, event: 'roster_imported', audience: 'teacher' });
      return preview;
    } catch (error) {
      if (error instanceof Error && error.message === 'ROSTER_IMPORT_STUDENT_NUMBER_CONFLICT') return { ...preview, issues: [{ line: 1, message: '名單匯入時發現既有或併發重複學號，未匯入任何資料' }] };
      throw error;
    }
  }

  requestJoin(classId: ClassId, displayName: string, studentNumber: string): JoinResult {
    const name = normalizeText(displayName);
    const rawStudentNumber = normalizeText(studentNumber);
    const normalizedStudentNumber = normalizeStudentNumber(rawStudentNumber);
    if (name.length === 0 || normalizedStudentNumber.length === 0) throw new Error('JOIN_IDENTITY_REQUIRED');
    const matched = this.dependencies.repository.findStudentByRosterIdentity(classId, name, normalizedStudentNumber);
    if (matched !== undefined) return { outcome: 'matched', student: matched };
    const now = this.now() as IsoUtc;
    const pending: PendingStudentRequest = {
      id: this.createPendingRequestId(), classId, displayName: name, rawStudentNumber, normalizedStudentNumber, requestedAtUtc: now, status: 'pending'
    };
    const request = this.dependencies.repository.createOrGetPendingRequest(pending);
    this.notify({ classId, resourceType: 'pending', id: request.id, event: 'pending_requested', audience: 'teacher' });
    return { outcome: 'pending', request };
  }

  approvePendingRequest(teacherContext: unknown, requestId: PendingStudentRequestId): ReturnType<ClassRosterRepository['approvePendingRequest']> {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    const student = this.dependencies.repository.approvePendingRequest(requestId, this.createStudentId, this.now());
    this.notify({ classId: student.classId, resourceType: 'pending', id: requestId, event: 'pending_resolved', audience: 'teacher' });
    this.notify({ classId: student.classId, resourceType: 'roster', id: student.classId, event: 'roster_changed', audience: 'teacher' });
    return student;
  }

  private notify(event: Readonly<{ classId: ClassId; resourceType: 'pending' | 'roster'; id: string; event: string; audience: 'teacher' }>): void {
    try { this.dependencies.notify?.(event); } catch { /* notification failure cannot roll back REST persistence */ }
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim();
}

type ParsedCsvRow = Readonly<{ fields: readonly string[]; line: number }>;

function parseCsv(csv: string): Readonly<{ rows: readonly ParsedCsvRow[]; issues: readonly CsvIssue[]; ignoredColumnLines: readonly number[] }> {
  const text = csv.replace(/^\uFEFF/, '');
  const rows: ParsedCsvRow[] = [];
  let current: string[] = [];
  let field = '';
  let quoted = false;
  let physicalLine = 1;
  let rowLine = 1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else {
        field += character;
        if (character === '\r') {
          if (text[index + 1] === '\n') { field += '\n'; index += 1; }
          physicalLine += 1;
        } else if (character === '\n') physicalLine += 1;
      }
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ',') { current.push(field); field = ''; continue; }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      current.push(field); field = ''; rows.push({ fields: current, line: rowLine }); current = [];
      physicalLine += 1; rowLine = physicalLine;
      continue;
    }
    field += character;
  }
  if (quoted) return { rows: [], issues: [{ line: physicalLine, message: 'CSV 引號未正確結束' }], ignoredColumnLines: [] };
  if (field.length > 0 || current.length > 0) { current.push(field); rows.push({ fields: current, line: rowLine }); }
  const nonBlankRows = rows.filter((row) => row.fields.some((value) => value.length > 0));
  const header = nonBlankRows.shift();
  if (header === undefined) return { rows: [], issues: [{ line: 1, message: 'CSV 必須包含標題列：姓名,學號' }], ignoredColumnLines: [] };
  const expected = header.fields.map(normalizeText);
  const nameFirst = (expected[0] === '姓名' && expected[1] === '學號') || (expected[0] === 'name' && expected[1] === 'studentNumber');
  const numberFirst = (expected[0] === '學號' && expected[1] === '姓名') || (expected[0] === 'studentNumber' && expected[1] === 'name');
  if (!nameFirst && !numberFirst) {
    return { rows: [], issues: [{ line: header.line, message: 'CSV 標題必須為「姓名,學號」、「學號,姓名」、name,studentNumber 或 studentNumber,name' }], ignoredColumnLines: [] };
  }
  const normalizedRows = numberFirst ? nonBlankRows.map((row) => ({ ...row, fields: [row.fields[1] ?? '', row.fields[0] ?? ''] })) : nonBlankRows;
  return { rows: normalizedRows, issues: [], ignoredColumnLines: nonBlankRows.filter((row) => row.fields.length > 2).map((row) => row.line) };
}
