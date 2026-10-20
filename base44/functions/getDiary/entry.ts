// Base44 backend function: getDiary
// Thin entry point. All logic and checks live in shared/lib/server/handlers.ts (tested in lib/server).
// Runtime assumption (Deno, npm: specifier) to be confirmed when the Base44 app is linked (issue P1-01).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { getDiary } from '../../shared/lib/server/handlers.ts';
import { runHandler } from '../../shared/adapters/base44.ts';

// deno-lint-ignore no-explicit-any
Deno.serve((req: Request) => runHandler(req, (r) => createClientFromRequest(r) as any, getDiary));
