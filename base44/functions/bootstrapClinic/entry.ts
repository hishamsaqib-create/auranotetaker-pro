// Base44 backend function: bootstrapClinic
// First-run setup only. Logic and checks live in shared/lib/server/bootstrap.ts (tested in lib/server).
// Shape per Base44's backend-function docs: a default-exported request handler; secrets read per request.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { secrets } from 'base44:runtime';
import { runBootstrap } from '../../shared/adapters/base44.ts';

export default function (req: Request): Promise<Response> {
  // deno-lint-ignore no-explicit-any
  return runBootstrap(req, (r) => createClientFromRequest(r) as any, (name) => secrets.get(name));
}
