import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteDatabase } from '../db/connection.js';
import type { AuthorizedStudentContext } from '../domain/types.js';

type TeacherContext = (request: IncomingMessage) => unknown;
type StudentContext = (request: IncomingMessage) => AuthorizedStudentContext;

/** Read-only navigation DTOs.  These queries intentionally omit answer keys,
 * reference answers, session material and every other student's identity. */
export function createActivityRoutes(dependencies: Readonly<{ database: SqliteDatabase; teacherContext: TeacherContext; studentContext: StudentContext }>): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method !== 'GET') return false;

    const teacherClass = /^\/api\/teacher\/classes\/([^/]+)\/(roster|pending-student-requests|questions|file-tasks)$/.exec(url.pathname);
    if (teacherClass !== null) {
      dependencies.teacherContext(request);
      const classId = decodeURIComponent(teacherClass[1]!);
      if (!classExists(dependencies.database, classId)) throw new Error('CLASS_NOT_FOUND');
      const resource = teacherClass[2];
      if (resource === 'roster') return send(response, students(dependencies.database, classId));
      if (resource === 'pending-student-requests') return send(response, pending(dependencies.database, classId));
      if (resource === 'questions') return send(response, questions(dependencies.database, classId));
      return send(response, fileTasks(dependencies.database, classId));
    }
    if (url.pathname === '/api/teacher/classes') {
      dependencies.teacherContext(request);
      return send(response, dependencies.database.prepare('SELECT id,name,created_at_utc AS createdAtUtc,updated_at_utc AS updatedAtUtc FROM classes ORDER BY name,id').all());
    }
    if (url.pathname === '/api/student/activities') {
      const student = dependencies.studentContext(request);
      return send(response, {
        questions: dependencies.database.prepare("SELECT id,prompt,kind,state FROM questions WHERE class_id=? AND state IN ('open','closed') ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END,opened_at_utc DESC,id").all(student.classId),
        fileTasks: dependencies.database.prepare("SELECT id,title,description,state,deadline_at_utc AS deadlineAtUtc FROM file_submission_tasks WHERE class_id=? AND state IN ('open','closed') ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END,deadline_at_utc,id").all(student.classId)
      });
    }
    return false;
  };
}

function classExists(database: SqliteDatabase, classId: string): boolean { return database.prepare('SELECT 1 FROM classes WHERE id=?').get(classId) !== undefined; }
function students(database: SqliteDatabase, classId: string): unknown {
  return database.prepare('SELECT id,display_name AS displayName,raw_student_number AS studentNumber,is_temporary AS isTemporary,approved_at_utc AS approvedAtUtc FROM students WHERE class_id=? ORDER BY display_name,id').all(classId);
}
function pending(database: SqliteDatabase, classId: string): unknown {
  return database.prepare("SELECT id,class_id AS classId,display_name AS displayName,raw_student_number AS studentNumber,requested_at_utc AS requestedAtUtc FROM pending_student_requests WHERE class_id=? AND status='pending' ORDER BY requested_at_utc,id").all(classId);
}
function questions(database: SqliteDatabase, classId: string): unknown {
  return database.prepare('SELECT id,class_id AS classId,kind,prompt,state,template_id AS templateId FROM questions WHERE class_id=? ORDER BY created_at_utc DESC,id').all(classId);
}
function fileTasks(database: SqliteDatabase, classId: string): unknown {
  return database.prepare('SELECT id,class_id AS classId,title,description,state,deadline_at_utc AS deadlineAtUtc,max_bytes AS maxBytes FROM file_submission_tasks WHERE class_id=? ORDER BY created_at_utc DESC,id').all(classId);
}
function send(response: ServerResponse, value: unknown): true {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
  return true;
}
