import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClassId, QuestionId, QuestionTemplateId } from '../../domain/types.js';
import { readBoundedJsonObject } from '../../http/bounded-json.js';
import { QuestionBankService } from './service.js';
import type { TemplateInput } from './types.js';

const MAX_BODY_BYTES = 16 * 1024;
export type QuestionBankRoutesDependencies = Readonly<{ service: QuestionBankService; teacherContext: (request: IncomingMessage) => unknown }>;

/** Opt-in only. The application composition root remains responsible for cookie/CSRF policy. */
export function createQuestionBankRoutes(dependencies: QuestionBankRoutesDependencies): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const templates = /^\/api\/question-templates(?:\/([^/]+))?$/.exec(url.pathname);
    if (templates !== null) {
      const id = templates[1] === undefined ? undefined : decodeURIComponent(templates[1]) as QuestionTemplateId;
      if (request.method === 'GET' && id === undefined) return respond(response, 200, dependencies.service.listTemplates(dependencies.teacherContext(request)));
      if (request.method === 'GET' && id !== undefined) return respond(response, 200, dependencies.service.getTemplate(dependencies.teacherContext(request), id));
      if (request.method === 'POST' && id === undefined) return respond(response, 201, dependencies.service.createTemplate(dependencies.teacherContext(request), templateBody(await readJson(request))));
      if (request.method === 'PUT' && id !== undefined) return respond(response, 200, dependencies.service.updateTemplate(dependencies.teacherContext(request), id, templateBody(await readJson(request))));
      if (request.method === 'DELETE' && id !== undefined) { requireEmptyOrObject(await readJson(request)); dependencies.service.deleteTemplate(dependencies.teacherContext(request), id); return respond(response, 204); }
      return false;
    }
    const drafts = /^\/api\/classes\/([^/]+)\/question-drafts(?:\/([^/]+))?$/.exec(url.pathname);
    if (drafts === null) return false;
    const classId = decodeURIComponent(drafts[1]!) as ClassId;
    const id = drafts[2] === undefined ? undefined : decodeURIComponent(drafts[2]) as QuestionId;
    if (request.method === 'POST' && id === undefined) return respond(response, 201, dependencies.service.createDraft(dependencies.teacherContext(request), classId, draftBody(await readJson(request))));
    if (request.method === 'GET' && id !== undefined) return respond(response, 200, dependencies.service.getDraft(dependencies.teacherContext(request), classId, id));
    if (request.method === 'PUT' && id !== undefined) return respond(response, 200, dependencies.service.updateDraft(dependencies.teacherContext(request), classId, id, templateBody(await readJson(request))));
    if (request.method === 'DELETE' && id !== undefined) { requireEmptyOrObject(await readJson(request)); dependencies.service.deleteDraft(dependencies.teacherContext(request), classId, id); return respond(response, 204); }
    return false;
  };
}

function templateBody(body: Record<string, unknown>): TemplateInput {
  assertExactKeys(body, ['kind', 'prompt', 'options', 'referenceAnswer']);
  const base = { kind: body.kind as TemplateInput['kind'], prompt: body.prompt as string };
  const options = Object.hasOwn(body, 'options') ? { options: body.options as readonly Readonly<{ id?: string; label: string }>[] } : {};
  const referenceAnswer = Object.hasOwn(body, 'referenceAnswer') ? { referenceAnswer: body.referenceAnswer } : {};
  return { ...base, ...options, ...referenceAnswer };
}
function draftBody(body: Record<string, unknown>): Readonly<{ templateId?: string; question?: TemplateInput }> {
  assertExactKeys(body, ['templateId', 'question']);
  if (typeof body.templateId === 'string' && body.question === undefined) return { templateId: body.templateId };
  if (body.templateId === undefined && isRecord(body.question)) return { question: templateBody(body.question) };
  throw new Error('QUESTION_DRAFT_INVALID');
}
function assertExactKeys(body: Record<string, unknown>, allowed: readonly string[]): void { if (Object.keys(body).some((key) => !allowed.includes(key))) throw new Error('REQUEST_UNEXPECTED_FIELD'); }
function requireEmptyOrObject(body: Record<string, unknown>): void { if (Object.keys(body).length !== 0) throw new Error('REQUEST_UNEXPECTED_FIELD'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { return readBoundedJsonObject(request, MAX_BODY_BYTES); }
function respond(response: ServerResponse, status: number, body?: unknown): true {
  const headers = { 'cache-control': 'no-store', ...(status === 204 ? {} : { 'content-type': 'application/json; charset=utf-8' }) };
  response.writeHead(status, headers);
  response.end(status === 204 ? undefined : JSON.stringify(body));
  return true;
}
