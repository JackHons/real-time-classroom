import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createQuestionBankRoutes } from '../../../../apps/server/src/questions/bank/http-routes.js';
import type { QuestionBankService } from '../../../../apps/server/src/questions/bank/service.js';

function request(): PassThrough & IncomingMessage { const value = new PassThrough() as PassThrough & IncomingMessage; value.method = 'POST'; value.url = '/api/question-templates'; return value; }
function response(): ServerResponse { return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse; }

describe('question bank HTTP routes', () => {
  it('rejects mass-assigned fields before calling the teacher command port', async () => {
    const createTemplate = vi.fn();
    const handler = createQuestionBankRoutes({ service: { createTemplate } as unknown as QuestionBankService, teacherContext: () => 'teacher' });
    const input = request(); const handling = handler(input, response());
    input.end(JSON.stringify({ kind: 'short_text', prompt: 'Why?', isAdmin: true }));
    await expect(handling).rejects.toThrow('REQUEST_UNEXPECTED_FIELD');
    expect(createTemplate).not.toHaveBeenCalled();
  });
});
