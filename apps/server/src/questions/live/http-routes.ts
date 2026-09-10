import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeleteConfirmation, QuestionId, StudentId } from '../../domain/types.js';
import { readBoundedJsonObject } from '../../http/bounded-json.js';
import type { AnswerInput, ClosedQuestionView, LiveQuestionRouteDependencies } from './types.js';

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_CLOSED_ANSWER_LIMIT = 50;
const MAX_CLOSED_ANSWER_LIMIT = 100;

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
      json(response, 200, isClosedQuestionView(actor) ? paginatedClosedView(actor, url) : actor);
      return true;
    }
    const open = /^\/api\/questions\/([^/]+)\/open$/.exec(url.pathname);
    if (request.method === 'POST' && open?.[1] !== undefined) {
      const teacher = dependencies.teacherContext(request);
      requireEmptyObject(await readJson(request));
      dependencies.service.open(teacher, decodeURIComponent(open[1]) as QuestionId);
      json(response, 204, undefined);
      return true;
    }
    const close = /^\/api\/questions\/([^/]+)\/close$/.exec(url.pathname);
    if (request.method === 'POST' && close?.[1] !== undefined) {
      const teacher = dependencies.teacherContext(request);
      requireEmptyObject(await readJson(request));
      json(response, 200, dependencies.service.close(teacher, decodeURIComponent(close[1]) as QuestionId));
      return true;
    }
    const answer = /^\/api\/questions\/([^/]+)\/answers$/.exec(url.pathname);
    if ((request.method === 'POST' || request.method === 'PUT') && answer?.[1] !== undefined) {
      const student = dependencies.studentContext(request);
      const body = await readJson(request);
      const input = answerInput(body);
      const id = decodeURIComponent(answer[1]) as QuestionId;
      const result = request.method === 'PUT'
        ? dependencies.service.update(student, id, input)
        : dependencies.service.answer(student, id, input);
      json(response, 200, result);
      return true;
    }
    const deleteMatch = /^\/api\/questions\/([^/]+)\/answers\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'DELETE' && deleteMatch?.[1] !== undefined && deleteMatch[2] !== undefined) {
      const teacher = dependencies.teacherContext(request);
      const body = await readJson(request);
      dependencies.service.deleteAnswer(teacher, decodeURIComponent(deleteMatch[1]) as QuestionId, decodeURIComponent(deleteMatch[2]) as StudentId, deleteConfirmation(body));
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
function requireEmptyObject(body: Record<string, unknown>): void { if (Object.keys(body).length !== 0) throw new Error('REQUEST_UNEXPECTED_FIELD'); }

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { return readBoundedJsonObject(request, MAX_BODY_BYTES); }

function isClosedQuestionView(value: ReturnType<LiveQuestionRouteDependencies['service']['readForTeacher']> | ReturnType<LiveQuestionRouteDependencies['service']['readForStudent']>): value is ClosedQuestionView {
  return 'snapshot' in value && 'answers' in value;
}

function paginatedClosedView(view: ClosedQuestionView, url: URL): Readonly<ClosedQuestionView & { nextCursor: string | undefined }> {
  const limit = parseLimit(url.searchParams.get('limit'));
  const offset = parseCursor(url.searchParams.get('cursor'));
  const answers = view.answers.slice(offset, offset + limit);
  const nextCursor = offset + answers.length < view.answers.length ? String(offset + answers.length) : undefined;
  return { ...view, answers, nextCursor };
}

function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_CLOSED_ANSWER_LIMIT;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_CLOSED_ANSWER_LIMIT) : DEFAULT_CLOSED_ANSWER_LIMIT;
}

function parseCursor(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const headers = { 'cache-control': 'no-store', ...(status === 204 ? {} : { 'content-type': 'application/json; charset=utf-8' }) };
  response.writeHead(status, headers);
  response.end(status === 204 ? undefined : JSON.stringify(body));
}
