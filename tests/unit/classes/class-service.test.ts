import { describe, expect, it } from 'vitest';
import { ClassService } from '../../../apps/server/src/classes/class-service.js';
import type { ClassRosterRepository, TeacherAuthorization } from '../../../apps/server/src/classes/types.js';
import type { Class, ClassId, PendingStudentRequest, PendingStudentRequestId, Student, StudentId } from '../../../apps/server/src/domain/types.js';

const ids = { class: 'class-1' as ClassId, student: 'student-1' as StudentId, pending: 'pending-1' as PendingStudentRequestId };
const teacher: TeacherAuthorization = { assertAuthorized(context) { if (context !== 'teacher') throw new Error('TEACHER_AUTH_REQUIRED'); } };

function repository(): ClassRosterRepository & { readonly classes: Class[]; readonly students: Student[]; readonly pending: PendingStudentRequest[] } {
  const classes: Class[] = [];
  const students: Student[] = [];
  const pending: PendingStudentRequest[] = [];
  return {
    classes, students, pending,
    listClasses: () => classes.map(({ id, name }) => ({ id, name })),
    createClass: (item) => { classes.push(item); },
    deleteClass: (id) => { const index = classes.findIndex((item) => item.id === id); if (index < 0) throw new Error('CLASS_NOT_FOUND'); classes.splice(index, 1); },
    classExists: (id) => classes.some((item) => item.id === id),
    hasStudentNumber: (classId, number) => students.some((item) => item.classId === classId && item.normalizedStudentNumber === number),
    findStudentByRosterIdentity: (classId, name, number) => students.find((item) => item.classId === classId && item.displayName === name && item.normalizedStudentNumber === number),
    findPendingRequest: (classId, number) => pending.find((item) => item.classId === classId && item.normalizedStudentNumber === number && item.status === 'pending'),
    createOrGetPendingRequest: (item) => { const existing = pending.find((candidate) => candidate.classId === item.classId && candidate.normalizedStudentNumber === item.normalizedStudentNumber && candidate.status === 'pending'); if (existing !== undefined) return existing; pending.push(item); return item; },
    importRoster: (classId, entries, createStudentId, approvedAtUtc) => {
      if (entries.some((entry) => students.some((student) => student.classId === classId && student.normalizedStudentNumber === entry.normalizedStudentNumber))) throw new Error('ROSTER_IMPORT_STUDENT_NUMBER_CONFLICT');
      students.push(...entries.map((entry) => ({ id: createStudentId(), classId, ...entry, isTemporary: false, approvedAtUtc: approvedAtUtc as never })));
    },
    approvePendingRequest: (requestId, createStudentId, approvedAtUtc) => {
      const request = pending.find((item) => item.id === requestId && item.status === 'pending');
      if (request === undefined) throw new Error('PENDING_REQUEST_NOT_FOUND_OR_RESOLVED');
      if (students.some((item) => item.classId === request.classId && item.normalizedStudentNumber === request.normalizedStudentNumber)) throw new Error('PENDING_APPROVAL_STUDENT_NUMBER_CONFLICT');
      const index = pending.findIndex((item) => item.id === request.id);
      pending[index] = { ...request, status: 'approved' };
      const created: Student = { id: createStudentId(), classId: request.classId, displayName: request.displayName, rawStudentNumber: request.rawStudentNumber, normalizedStudentNumber: request.normalizedStudentNumber, isTemporary: true, approvedAtUtc: approvedAtUtc as never };
      students.push(created);
      return created;
    }
  };
}

function service(repo = repository()): ClassService {
  return new ClassService({ repository: repo, teacherAuthorization: teacher, now: () => '2026-09-07T00:00:00.000Z', createClassId: () => ids.class, createStudentId: () => ids.student, createPendingRequestId: () => ids.pending });
}

describe('ClassService', () => {
  it('lists classes publicly but authorizes teacher mutations and requires delete confirmation', () => {
    const repo = repository();
    const subject = service(repo);
    expect(subject.listPublicClasses()).toEqual([]);
    expect(() => subject.createClass('student', '1A')).toThrow('TEACHER_AUTH_REQUIRED');
    expect(subject.createClass('teacher', ' １Ａ ')).toMatchObject({ id: ids.class, name: '1A' });
    expect(subject.listPublicClasses()).toEqual([{ id: ids.class, name: '1A' }]);
    expect(() => subject.deleteClass('teacher', ids.class, { confirmed: true, impactAcknowledged: false })).toThrow('CLASS_DELETE_CONFIRMATION_REQUIRED');
    subject.deleteClass('teacher', ids.class, { confirmed: true, impactAcknowledged: true });
    expect(subject.listPublicClasses()).toEqual([]);
  });

  it('previews normalized CSV and reports Traditional-Chinese line errors without accepting malformed imports', () => {
    const subject = service();
    expect(subject.previewRosterCsv('姓名,學號\n 王小明 , ａb-１２ \n李四,CD3')).toMatchObject({ rows: [{ displayName: '王小明', rawStudentNumber: 'ab-12', normalizedStudentNumber: 'AB-12' }, { normalizedStudentNumber: 'CD3' }], issues: [] });
    expect(subject.previewRosterCsv('姓名,學號\n, A1\nB, a1')).toEqual({ rows: [{ displayName: '', rawStudentNumber: 'A1', normalizedStudentNumber: 'A1' }, { displayName: 'B', rawStudentNumber: 'a1', normalizedStudentNumber: 'A1' }], issues: [{ line: 2, message: '姓名不可為空白' }, { line: 3, message: 'CSV 內學號重複' }] });
  });

  it('accepts the classroom-facing student-number-first CSV order and stores the same roster identity', () => {
    const repo = repository(); const subject = service(repo);
    subject.createClass('teacher', '1A');
    expect(subject.previewRosterCsv('學號,姓名\nS100,王小明')).toEqual({ rows: [{ displayName: '王小明', rawStudentNumber: 'S100', normalizedStudentNumber: 'S100' }], issues: [] });
    subject.importRosterCsv('teacher', ids.class, '學號,姓名\nS100,王小明');
    expect(repo.students).toMatchObject([{ displayName: '王小明', rawStudentNumber: 'S100', normalizedStudentNumber: 'S100' }]);
  });

  it('accepts a third status column but makes its non-storage explicit in the preview', () => {
    const repo = repository(); const subject = service(repo);
    subject.createClass('teacher', '1A');
    expect(subject.previewRosterCsv('學號,姓名,狀態\nS100,王小明,在測試中')).toEqual({
      rows: [{ displayName: '王小明', rawStudentNumber: 'S100', normalizedStudentNumber: 'S100' }], issues: [], ignoredColumnLines: [2]
    });
    subject.importRosterCsv('teacher', ids.class, '學號,姓名,狀態\nS100,王小明,在測試中');
    expect(repo.students).toMatchObject([{ displayName: '王小明', rawStudentNumber: 'S100', normalizedStudentNumber: 'S100' }]);
  });

  it('keeps physical CSV line numbers when blank rows are ignored', () => {
    const repo = repository();
    const subject = service(repo);
    expect(subject.previewRosterCsv('姓名,學號\n\n\n,A1\nB,a1')).toEqual({
      rows: [{ displayName: '', rawStudentNumber: 'A1', normalizedStudentNumber: 'A1' }, { displayName: 'B', rawStudentNumber: 'a1', normalizedStudentNumber: 'A1' }],
      issues: [{ line: 4, message: '姓名不可為空白' }, { line: 5, message: 'CSV 內學號重複' }]
    });
    subject.createClass('teacher', '1A');
    subject.importRosterCsv('teacher', ids.class, '姓名,學號\nAda,A1');
    expect(subject.importRosterCsv('teacher', ids.class, '姓名,學號\n\n\nBen,a1')).toEqual({
      rows: [{ displayName: 'Ben', rawStudentNumber: 'a1', normalizedStudentNumber: 'A1' }],
      issues: [{ line: 4, message: '學號已存在於班級名單' }]
    });
  });

  it('matches an exact roster name and number, otherwise creates/reuses a pending request that is not a student', () => {
    const repo = repository();
    const subject = service(repo);
    subject.createClass('teacher', '1A');
    subject.importRosterCsv('teacher', ids.class, 'name,studentNumber\nAda,A1');
    expect(subject.requestJoin(ids.class, ' Ada ', ' ａ1 ')).toMatchObject({ outcome: 'matched', student: { isTemporary: false } });
    const first = subject.requestJoin(ids.class, 'Not Ada', 'A1');
    const duplicate = subject.requestJoin(ids.class, 'Other', 'a1');
    expect(first).toMatchObject({ outcome: 'pending', request: { id: ids.pending, status: 'pending' } });
    expect(duplicate).toEqual(first);
    expect(repo.students).toHaveLength(1);
  });

  it('approves only once and creates a temporary student; an existing roster number wins conflict', () => {
    const repo = repository();
    const subject = service(repo);
    subject.createClass('teacher', '1A');
    const pending = subject.requestJoin(ids.class, 'Ada', 'A1');
    if (pending.outcome !== 'pending') throw new Error('test setup');
    expect(() => subject.approvePendingRequest('student', pending.request.id)).toThrow('TEACHER_AUTH_REQUIRED');
    expect(subject.approvePendingRequest('teacher', pending.request.id)).toMatchObject({ isTemporary: true, normalizedStudentNumber: 'A1' });
    expect(() => subject.approvePendingRequest('teacher', pending.request.id)).toThrow('PENDING_REQUEST_NOT_FOUND_OR_RESOLVED');
  });
});
