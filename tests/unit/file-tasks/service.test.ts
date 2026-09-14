import { describe, expect, it } from 'vitest';
import type { FileSubmission, FileSubmissionTask, FileSubmissionTaskId, IsoUtc, StudentId } from '../../../apps/server/src/domain/types.js';
import { FileTaskService } from '../../../apps/server/src/file-tasks/service.js';
import type { FileStoragePort, FileTaskRepository, NewFileSubmission } from '../../../apps/server/src/file-tasks/types.js';

const deadline = '2026-09-08T01:00:00.000Z' as IsoUtc;
function setup(now = new Date('2026-09-08T00:00:00.000Z')) {
  const tasks = new Map<string, FileSubmissionTask>(); const submissions = new Map<string, FileSubmission>(); const deleted = new Map<string, FileSubmission>(); let restored = 0; let committed = 0;
  const repository: FileTaskRepository = {
    createTask: (task) => { tasks.set(task.id, task); return task; }, task: (id) => tasks.get(id),
    updateDraft: (id, input) => { const task = tasks.get(id); if (task?.state !== 'draft') return undefined; const next = { ...task, ...input }; tasks.set(id, next); return next; },
    openTask: (id, openedAtUtc) => { const task = tasks.get(id); if (task?.state !== 'draft' && task?.state !== 'closed') return undefined; const next = { ...task, state: 'open' as const, openedAtUtc: task.openedAtUtc ?? openedAtUtc, closedAtUtc: null }; tasks.set(id, next); return next; },
    closeTask: (id, closedAtUtc) => { const task = tasks.get(id); if (task?.state !== 'open') return undefined; const next = { ...task, state: 'closed' as const, closedAtUtc }; tasks.set(id, next); return next; },
    completion: () => ({ eligibleStudentCount: 2, submittedStudentCount: submissions.size }),
    studentSubmission: (taskId, studentId) => submissions.get(`${taskId}:${studentId}`), closedSubmissions: () => [],
    dashboard: (taskId) => {
      const values = [...submissions.values()].filter((entry) => entry.taskId === taskId);
      return { completion: { eligibleStudentCount: 2, submittedStudentCount: values.length }, submissions: values.map((entry) => ({ studentId: entry.studentId, displayName: 'Ada', studentNumber: 'A1', displayFilename: entry.displayFilename, declaredMimeType: entry.declaredMimeType, byteLength: entry.byteLength, sha256: entry.sha256, receivedCompleteAtUtc: entry.receivedCompleteAtUtc })), missingStudents: values.length === 0 ? [{ studentId: 'student-1' as StudentId, displayName: 'Ada', studentNumber: 'A1' }] : [] };
    },
    createSubmission: (input) => { const value = { id: `s-${submissions.size}` as never, ...input, deletedAtUtc: null }; submissions.set(`${input.taskId}:${input.studentId}`, value); return value; },
    markSubmissionDeleted: (taskId, studentId) => { const value = submissions.get(`${taskId}:${studentId}`); if (value !== undefined) { submissions.delete(`${taskId}:${studentId}`); deleted.set(value.id, value); } return value; },
    restoreSubmission: (id) => { restored++; const value = deleted.get(id); if (value !== undefined) submissions.set(`${value.taskId}:${value.studentId}`, value); }, deleteEmptyTask: (id) => { if ([...submissions.values()].some((entry) => entry.taskId === id)) return false; return tasks.delete(id); }
  };
  const storage: FileStoragePort = { stageDeletion: () => ({ commit: () => { committed++; }, rollback: () => undefined }) };
  const service = new FileTaskService({ repository, storage, classExists: () => true, now: () => now, createTaskId: () => 'task-1' as FileSubmissionTaskId, teacherAuthorization: { assertAuthorized: (value) => { if (value !== 'teacher') throw new Error('TEACHER_AUTH_REQUIRED'); } }, studentAuthorization: { assertAuthorized: (value) => { if (value !== 'student') throw new Error('STUDENT_AUTH_REQUIRED'); return { studentId: 'student-1' as StudentId, classId: 'class-1' as never, studentSessionId: 'session-1' as never, csrfValidated: true }; } } });
  return { service, tasks, submissions, storage, metrics: () => ({ restored, committed }) };
}

describe('file task service', () => {
  it('enforces draft/open/closed and server-authoritative deadline boundaries', () => {
    const { service } = setup();
    const draft = service.createDraft('teacher', 'class-1' as never, { title: ' Assignment ', description: '', deadlineAtUtc: deadline });
    expect(draft).toMatchObject({ title: 'Assignment', state: 'draft', maxBytes: 100000000 });
    expect(() => service.prepareSubmission('student', draft.id)).toThrow('FILE_TASK_NOT_FOUND');
    service.open('teacher', draft.id);
    expect(service.prepareSubmission('student', draft.id).state).toBe('open');
    service.close('teacher', draft.id);
    expect(() => service.prepareSubmission('student', draft.id)).toThrow('FILE_TASK_CLOSED');
    const late = setup(new Date('2026-09-08T02:00:00.000Z'));
    const lateDraft = late.service.createDraft('teacher', 'class-1' as never, { title: 'x', description: '', deadlineAtUtc: deadline });
    expect(() => late.service.open('teacher', lateDraft.id)).toThrow('FILE_TASK_DEADLINE_PASSED');

    // The same server-authoritative boundary is inclusive: completion at the
    // advertised deadline is valid, while any later completion is rejected.
    const exact = setup(new Date(deadline));
    const exactDraft = exact.service.createDraft('teacher', 'class-1' as never, { title: 'exact', description: '', deadlineAtUtc: deadline });
    exact.service.open('teacher', exactDraft.id);
    expect(exact.service.commitSubmission('student', { taskId: exactDraft.id, originalFilename: 'x.txt', displayFilename: 'x.txt', storageKey: 'object/exact', declaredMimeType: null, byteLength: 1, sha256: 'b'.repeat(64), receivedCompleteAtUtc: deadline })).toMatchObject({ taskId: exactDraft.id });
  });

  it('blocks duplicate successful metadata and rolls a failed storage delete back to live metadata', () => {
    const { service, storage, metrics } = setup();
    const task = service.createDraft('teacher', 'class-1' as never, { title: 'x', description: '', deadlineAtUtc: deadline }); service.open('teacher', task.id);
    const input: Omit<NewFileSubmission, 'studentId'> = { taskId: task.id, originalFilename: 'a.pdf', displayFilename: 'a.pdf', storageKey: 'object/a', declaredMimeType: 'application/pdf', byteLength: 3, sha256: 'a'.repeat(64), receivedCompleteAtUtc: '2026-09-08T00:30:00.000Z' as IsoUtc };
    service.commitSubmission('student', input);
    expect(() => service.commitSubmission('student', input)).toThrow('FILE_SUBMISSION_ALREADY_EXISTS');
    (storage.stageDeletion as unknown as () => { commit(): void; rollback(): void }) = () => ({ commit: () => { throw new Error('DISK_IO'); }, rollback: () => undefined });
    expect(() => service.deleteSubmission('teacher', task.id, 'student-1' as StudentId, { confirmed: true, impactAcknowledged: true })).toThrow('DISK_IO');
    expect(metrics().restored).toBe(1);
    expect(service.readForStudent('student', task.id).submission.submitted).toBe(true);
  });

  it('reopens a manually closed future-deadline task and exposes an all-state teacher dashboard', () => {
    const { service } = setup();
    const task = service.createDraft('teacher', 'class-1' as never, { title: 'x', description: '', deadlineAtUtc: deadline });
    service.open('teacher', task.id);
    service.close('teacher', task.id);
    const closed = service.readForTeacher('teacher', task.id);
    expect(closed).toMatchObject({ task: { state: 'closed' }, dashboard: { completion: { eligibleStudentCount: 2, submittedStudentCount: 0 }, missingStudents: [{ displayName: 'Ada' }] } });
    expect(service.open('teacher', task.id)).toMatchObject({ state: 'open', closedAtUtc: null });
    expect(service.open('teacher', task.id)).toMatchObject({ state: 'open' });
  });
});
