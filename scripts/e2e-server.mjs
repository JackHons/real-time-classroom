import argon2 from '../apps/server/node_modules/argon2/argon2.cjs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { openSqlite } from '../apps/server/dist/db/connection.js';
import { migrate } from '../apps/server/dist/db/migrator.js';
import { TEACHER_PASSWORD_ARGON2_POLICY } from '../apps/server/dist/auth/password.js';

// Every web-server invocation gets an independent runtime outside the checkout,
// so no developer database or a previous browser run can be reused.
const runtimeDirectory = mkdtempSync(join(tmpdir(), 'lan-classroom-e2e-'));
const databasePath = join(runtimeDirectory, 'classroom.sqlite');
const database = openSqlite(databasePath);
migrate(database);
const now = '2026-09-10T00:00:00.000Z';
if (process.env.LAN_CLASSROOM_E2E_MODE !== 'setup') {
  const password = 'E2E-accessible-password-1!';
  const hash = await argon2.hash(password, TEACHER_PASSWORD_ARGON2_POLICY);
  database.prepare("INSERT INTO app_settings (key,value,created_at_utc,updated_at_utc) VALUES ('teacher_shared_password_hash',?,?,?)").run(hash, now, now);
  database.prepare('INSERT INTO classes (id,name,created_at_utc,updated_at_utc) VALUES (?,?,?,?)').run('e2e-class', '可及性測試課堂', now, now);
  for (const [id, number] of [['student-chrome', 'S-CHROME'], ['student-chrome-zoom', 'S-CHROME-ZOOM'], ['student-edge', 'S-EDGE'], ['student-edge-zoom', 'S-EDGE-ZOOM'], ['student-firefox', 'S-FIREFOX'], ['student-firefox-zoom', 'S-FIREFOX-ZOOM']]) {
    database.prepare('INSERT INTO students (id,class_id,display_name,raw_student_number,normalized_student_number,is_temporary,approved_at_utc) VALUES (?,?,?,?,?,?,?)').run(id, 'e2e-class', `學生 ${number}`, number, number, 0, now);
  }
  database.prepare('INSERT INTO questions (id,class_id,template_id,kind,prompt,reference_answer,state,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('e2e-question', 'e2e-class', null, 'single_choice', '今天的課堂重點是？', 'a', 'open', now, null, now, now);
  database.prepare('INSERT INTO question_options (id,question_id,option_key,label,ordinal) VALUES (?,?,?,?,?)').run('e2e-option-a', 'e2e-question', 'a', '可及性', 1);
  database.prepare('INSERT INTO question_options (id,question_id,option_key,label,ordinal) VALUES (?,?,?,?,?)').run('e2e-option-b', 'e2e-question', 'b', '網路', 2);
  database.prepare('INSERT INTO file_submission_tasks (id,class_id,title,description,state,max_bytes,deadline_at_utc,opened_at_utc,closed_at_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('e2e-task', 'e2e-class', '課堂作業', '請上傳作業檔案。', 'open', 100000000, '2099-01-01T00:00:00.000Z', now, null, now, now);
}
database.close();

const port = process.env.LAN_CLASSROOM_E2E_PORT ?? '4173';
const origin = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['apps/server/dist/main.js'], {
  cwd: process.cwd(), stdio: 'inherit', env: {
    ...process.env,
    LAN_CLASSROOM_DATABASE_PATH: databasePath,
    LAN_CLASSROOM_UPLOAD_STORAGE_PATH: join(runtimeDirectory, 'uploads'),
    LAN_CLASSROOM_ALLOWED_ORIGIN: origin,
    LAN_CLASSROOM_HOST: '127.0.0.1',
    LAN_CLASSROOM_PORT: port
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => process.exitCode = code ?? (signal === null ? 1 : 0));
