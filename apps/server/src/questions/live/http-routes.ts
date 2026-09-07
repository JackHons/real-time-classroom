import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeleteConfirmation, QuestionId, StudentId } from '../../domain/types.js';
import type { AnswerInput, LiveQuestionRouteDependencies } from './types.js';

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Opt-in routes only. The composition root must pass CSRF/session-aware context
 * factories; mounting this handler alone grants no authentication.
 */
export function createLiveQuestionRoutes(dependencies: LiveQuestionRouteDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const base = /^\/api\/questions\/([^/]+)$/.exec(url.pathname);
    const questionId = base?.[1] === undefined ? undefined : decodeURIComponent(base[1]) as QuestionId;
    if (request.method === 'GET' && questionId !== undefined) {
      const actor = url.searchParams.get('as') === 'student' ? dependencies.service.readForStudent(dependencies.studentContext(request), questionId) : dependencies.service.readForTeacher(dependencies.teacherContext(request), questionId);
      json(response, 200, actor);
      return true;
    }
    const open = /^\/api\/questions\/([^/]+)\/open$/.exec(url.pathname);
    if (request.method === 'POST' && open?.[1] !== undefined) {
      dependencies.service.open(dependencies.teacherContext(request), decodeURIComponent(open[1]) as QuestionId);
      json(response, 204, undefined);
      return true;
    }
    const close = /^\/api\/questions\/([^/]+)\/close$/.exec(url.pathname);
    if (request.method === 'POST' && close?.[1] !== undefined) {
      json(response, 200, dependencies.service.close(dependencies.teacherContext(request), decodeURIComponent(close[1]) as QuestionId));
      return true;
    }
    const answer = /^\/api\/questions\/([^/]+)\/answers$/.exec(url.pathname);
    if ((request.method === 'POST' || request.method === 'PUT') && answer?.[1] !== undefined) {
      const body = await readJson(request);
      const input = answerInput(body);
      const id = decodeURIComponent(answer[1]) as QuestionId;
      const result = request.method === 'PUT'
        ? dependencies.service.update(dependencies.studentContext(request), id, input)
        : dependencies.service.answer(dependencies.studentContext(request), id, input);
      json(response, 200, result);
      return true;
    }
    const deleteMatch = /^\/api\/questions\/([^/]+)\/answers\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && deleteMatch?.[1] !== undefined && deleteMatch[2] !== undefined) {
      const body = await readJson(request);
      dependencies.service.deleteAnswer(dependencies.teacherContext(request), decodeURIComponent(deleteMatch[1]) as QuestionId, decodeURIComponent(deleteMatch[2]) as StudentId, deleteConfirmation(body));
      json(response, 204, undefined);
      return true;
    }
    return false;
  };
}

function answerInput(body: Record<string, unknown>): AnswerInput {
  if (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision)) throw new Error('REQUEST_REVISION_REQUIRED');
  if (typeof body.idempotencyKey !== 'string') throw new Error('REQUEST_IDEMPOTENCYKEY_REQUIRED');
  if (!isObject(body.payload) || typeof body.payload.kind !== 'string') throw new Error('REQUEST_PAYLOAD_REQUIRED');
  const payload = body.payload;
  const selectedOptions = payload.selectedOptions;
  if (selectedOptions !== undefined && (!Array.isArray(selectedOptions) || !selectedOptions.every((value) => typeof value === 'string'))) throw new Error('REQUEST_PAYLOAD_INVALID');
  if (payload.text !== undefined && typeof payload.text !== 'string') throw new Error('REQUEST_PAYLOAD_INVALID');
  return { revision: body.revision, idempotencyKey: body.idempotencyKey, payload: { kind: payload.kind as AnswerInput['payload']['kind'], ...(selectedOptions === undefined ? {} : { selectedOptions }), ...(payload.text === undefined ? {} : { text: payload.text }) } };
}

function deleteConfirmation(body: Record<string, unknown>): DeleteConfirmation {
  if (body.confirmed !== true || body.impactAcknowledged !== true) throw new Error('DELETE_CONFIRMATION_REQUIRED');
  return { confirmed: true, impactAcknowledged: true };
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let settled = false;
    const stop = (): void => { request.removeListener('data', onData); request.removeListener('end', onEnd); };
    const fail = (error: Error): void => { if (!settled) { settled = true; stop(); request.resume(); reject(error); } };
    const onData = (chunk: string): void => { size += Buffer.byteLength(chunk); if (size > MAX_BODY_BYTES) fail(new Error('REQUEST_BODY_TOO_LARGE')); else raw += chunk; };
    const onEnd = (): void => { if (!settled) { try { const body: unknown = raw === '' ? {} : JSON.parse(raw); if (!isObject(body)) throw new Error('REQUEST_BODY_OBJECT_REQUIRED'); settled = true; stop(); resolve(body); } catch (error) { fail(error instanceof Error ? error : new Error('REQUEST_BODY_INVALID')); } } };
    request.setEncoding('utf8'); request.on('data', onData); request.on('end', onEnd); request.on('error', fail); request.on('aborted', () => fail(new Error('REQUEST_ABORTED')));
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (status === 204) { response.writeHead(204); response.end(); return; }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
