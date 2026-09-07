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
  }

  previewRosterCsv(csv: string): CsvPreview {
    const parsed = parseCsv(csv);
    if (parsed.issues.length > 0) return { rows: [], issues: parsed.issues };
    const rows = parsed.rows;
    const issues: CsvIssue[] = [];
    const output: RosterEntry[] = [];
    const seenNumbers = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const line = index + 2;
      const displayName = normalizeText(row[0] ?? '');
      const rawStudentNumber = normalizeText(row[1] ?? '');
      const normalizedStudentNumber = normalizeStudentNumber(rawStudentNumber);
      if (displayName.length === 0) issues.push({ line, message: '姓名不可為空白' });
      if (normalizedStudentNumber.length === 0) issues.push({ line, message: '學號不可為空白' });
      if (row.length !== 2) issues.push({ line, message: '每列必須剛好有姓名及學號兩欄' });
      if (normalizedStudentNumber.length > 0 && seenNumbers.has(normalizedStudentNumber)) issues.push({ line, message: 'CSV 內學號重複' });
      seenNumbers.add(normalizedStudentNumber);
      output.push({ displayName, rawStudentNumber, normalizedStudentNumber });
    }
    if (rows.length === 0) issues.push({ line: 1, message: 'CSV 不可沒有名單資料' });
    return { rows: output, issues };
  }

  importRosterCsv(teacherContext: unknown, classId: ClassId, csv: string): CsvPreview {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    const preview = this.previewRosterCsv(csv);
    if (preview.issues.length > 0) return preview;
    if (!this.dependencies.repository.classExists(classId)) return { ...preview, issues: [{ line: 1, message: '班級不存在' }] };
    const existingIssues = preview.rows.flatMap((entry, index) => this.dependencies.repository.hasStudentNumber(classId, entry.normalizedStudentNumber)
      ? [{ line: index + 2, message: '學號已存在於班級名單' }]
      : []);
    if (existingIssues.length > 0) return { ...preview, issues: existingIssues };
    try {
      this.dependencies.repository.importRoster(classId, preview.rows, this.createStudentId, this.now());
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
    return { outcome: 'pending', request: this.dependencies.repository.createOrGetPendingRequest(pending) };
  }

  approvePendingRequest(teacherContext: unknown, requestId: PendingStudentRequestId): ReturnType<ClassRosterRepository['approvePendingRequest']> {
    this.dependencies.teacherAuthorization.assertAuthorized(teacherContext);
    return this.dependencies.repository.approvePendingRequest(requestId, this.createStudentId, this.now());
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim();
}

function parseCsv(csv: string): Readonly<{ rows: readonly string[][]; issues: readonly CsvIssue[] }> {
  const text = csv.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ',') { current.push(field); field = ''; continue; }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      current.push(field); field = ''; rows.push(current); current = [];
      continue;
    }
    field += character;
  }
  if (quoted) return { rows: [], issues: [{ line: rows.length + 1, message: 'CSV 引號未正確結束' }] };
  if (field.length > 0 || current.length > 0) { current.push(field); rows.push(current); }
  const nonBlankRows = rows.filter((row) => row.some((value) => value.length > 0));
  const header = nonBlankRows.shift();
  if (header === undefined) return { rows: [], issues: [{ line: 1, message: 'CSV 必須包含標題列：姓名,學號' }] };
  const expected = header.map(normalizeText);
  if (expected.length !== 2 || !((expected[0] === '姓名' && expected[1] === '學號') || (expected[0] === 'name' && expected[1] === 'studentNumber'))) {
    return { rows: [], issues: [{ line: 1, message: 'CSV 標題必須為「姓名,學號」或「name,studentNumber」' }] };
  }
  return { rows: nonBlankRows, issues: [] };
}
