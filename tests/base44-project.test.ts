// Guards on the Base44 project files: every entity must declare explicit access rules
// (Base44 makes an entity fully open when none are defined), and every function must map
// onto a tested handler.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as handlers from '../lib/server/handlers.ts';

const root = join(__dirname, '..');
const entitiesDir = join(root, 'base44/entities');
const functionsDir = join(root, 'base44/functions');

const parseJsonc = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const entities = readdirSync(entitiesDir).map((file) => ({ file, schema: parseJsonc(readFileSync(join(entitiesDir, file), 'utf8')) }));

describe('Base44 entities', () => {
  it.each(entities.map((e) => [e.file, e.schema]))('%s is well-formed and named in kebab-case', (file, schema) => {
    expect(schema.type).toBe('object');
    expect(schema.name).toMatch(/^[A-Z][A-Za-z0-9]+$/);
    expect(file).toBe(`${kebab(schema.name)}.jsonc`);
    for (const req of schema.required ?? []) expect(Object.keys(schema.properties)).toContain(req);
  });

  it.each(entities.map((e) => [e.schema.name, e.schema]))('%s declares explicit access rules for every operation', (_name, schema) => {
    expect(schema.rls).toBeDefined();
    for (const op of ['create', 'read', 'update', 'delete']) expect(schema.rls).toHaveProperty(op);
  });

  it('denies all direct client access to clinical, audit and configuration entities', () => {
    for (const { schema } of entities.filter((e) => e.schema.name !== 'StaffProfile')) {
      expect(schema.rls, schema.name).toEqual({ create: false, read: false, update: false, delete: false });
    }
  });

  it('lets users read only their own staff profile and never write it', () => {
    const staff = entities.find((e) => e.schema.name === 'StaffProfile')!.schema;
    expect(staff.rls).toEqual({ create: false, read: { 'data.user_email': '{{user.email}}' }, update: false, delete: false });
  });

  it('never stores patient demographics', () => {
    const forbidden = /(patient_name|first_name|last_name|date_of_birth|dob|nhs_number|address|phone)/i;
    for (const { schema } of entities) expect(JSON.stringify(Object.keys(schema.properties))).not.toMatch(forbidden);
  });
});

describe('Base44 functions', () => {
  const functionNames = readdirSync(functionsDir);

  it.each(functionNames)('%s has an entry point that runs the matching tested handler', (name) => {
    const entry = join(functionsDir, name, 'entry.ts');
    expect(existsSync(entry)).toBe(true);
    expect(typeof (handlers as Record<string, unknown>)[name]).toBe('function');
    const source = readFileSync(entry, 'utf8');
    expect(source).toContain('export default function (req: Request)');
    expect(source).toContain(`runHandler(req, (r) => createClientFromRequest(r) as any, ${name}, (name) => secrets.get(name))`);
    expect(source).toContain("import { secrets } from 'base44:runtime';");
  });
});
