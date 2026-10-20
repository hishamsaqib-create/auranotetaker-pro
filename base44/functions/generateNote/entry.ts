// Base44 backend function: generateNote
// Thin entry point. All logic and checks live in shared/lib/server/handlers.ts (tested in lib/server).
// Shape per Base44's backend-function docs: a default-exported request handler; secrets read per request.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { secrets } from 'base44:runtime';
import { generateNote } from '../../shared/lib/server/handlers.ts';
import { runHandler } from '../../shared/adapters/base44.ts';

export default function (req: Request): Promise<Response> {
  // deno-lint-ignore no-explicit-any
  return runHandler(req, (r) => createClientFromRequest(r) as any, generateNote, (name) => secrets.get(name));
}
