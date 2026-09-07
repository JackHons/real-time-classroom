import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createFileTaskRoutes } from '../../../apps/server/src/file-tasks/http-routes.js';
import type { FileTaskRouteDependencies } from '../../../apps/server/src/file-tasks/types.js';

function request(url: string): PassThrough & IncomingMessage { const value = new PassThrough() as PassThrough & IncomingMessage; value.method = 'GET'; value.url = url; return value; }
function response(): ServerResponse { return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse; }

describe('file task HTTP routes', () => {
  it('uses a generic not-found result for a task routed under the wrong class before a teacher or student view is read', async () => {
    const readForTeacher = vi.fn(); const readForStudent = vi.fn();
    const dependencies: FileTaskRouteDependencies = {
      repository: { task: () => ({ id: 'task-1', classId: 'class-a' } as never) },
      service: { readForTeacher, readForStudent } as never,
      teacherContext: () => ({ teacher: true }), studentContext: () => ({ student: true })
    };
    const handler = createFileTaskRoutes(dependencies);
    await expect(handler(request('/api/classes/class-b/file-tasks/task-1'), response())).rejects.toThrow('FILE_TASK_NOT_FOUND');
    const student = request('/api/classes/class-b/file-tasks/task-1?as=student');
    await expect(handler(student, response())).rejects.toThrow('FILE_TASK_NOT_FOUND');
    expect(readForTeacher).not.toHaveBeenCalled();
    expect(readForStudent).not.toHaveBeenCalled();
  });
});
