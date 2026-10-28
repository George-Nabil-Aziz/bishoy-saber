// Edge function "admin-users": lets an admin add, edit and delete users (login + users row together).
// Deploy: Dashboard -> Edge Functions -> admin-users (keep "Verify JWT" on). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Body: { action: 'create' | 'update' | 'delete', ... }
import { createClient } from 'npm:@supabase/supabase-js@2';

const OWNER = 'bishoy.saber@gmail.com';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (error: string, status = 400, code?: string) => json({ error, code }, status);

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: 'bishoy_saber_notes' },
});

const isOwner = (email: string) => email.toLowerCase() === OWNER;
const isDup = (e: { code?: string; message?: string; status?: number } | null) =>
  !!e && (e.code === '23505' || e.code === 'email_exists' || e.status === 422 || /already|registered|exists/i.test(e.message || ''));

// Finds an Auth user by email (covers a login that was created by hand in the dashboard)
async function findAuthUser(email: string) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === email);
    if (hit || data.users.length < 1000) return hit || null;
  }
  return null;
}

function clean(b: Record<string, unknown>) {
  const name = String(b.name ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  const role = b.role === 'admin' ? 'admin' : 'user';
  const password = b.password ? String(b.password) : '';
  if (!name) return { error: 'Name is required' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Invalid email' };
  if (password && password.length < 6) return { error: 'Password must be at least 6 characters' };
  return { name, email, role, password };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Method not allowed', 405);
  try {
    // Who is calling? Must be a signed-in admin
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: au, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !au.user) return fail('Not signed in', 401);
    const { data: me } = await admin.from('users').select('id, email, role').eq('auth_id', au.user.id).maybeSingle();
    if (!me || !(me.role === 'admin' || isOwner(me.email))) return fail('Admins only', 403);

    const body = await req.json();
    const { action } = body;

    if (action === 'create') {
      const v = clean(body);
      if ('error' in v) return fail(v.error as string);
      if (!v.password) return fail('Password is required');
      const created = await admin.auth.admin.createUser({ email: v.email, password: v.password, email_confirm: true });
      if (created.error) return isDup(created.error) ? fail('Email already exists', 409, '23505') : fail(created.error.message);
      const row: Record<string, unknown> = { name: v.name, email: v.email, role: v.role, auth_id: created.data.user.id };
      if (body.avatar_url) row.avatar_url = body.avatar_url;
      const ins = await admin.from('users').insert(row).select('id').single();
      if (ins.error) {
        await admin.auth.admin.deleteUser(created.data.user.id); // no login without a row
        return isDup(ins.error) ? fail('Email already exists', 409, '23505') : fail(ins.error.message);
      }
      return json({ id: ins.data.id });
    }

    if (action === 'update' || action === 'delete') {
      const { data: row } = await admin.from('users').select('id, email, role, auth_id, avatar_url').eq('id', body.id).maybeSingle();
      if (!row) return fail('User not found', 404);

      if (action === 'delete') {
        if (isOwner(row.email)) return fail('The owner cannot be deleted', 403);
        if (row.id === me.id) return fail('You cannot delete yourself', 403);
        if (row.auth_id) {
          const del = await admin.auth.admin.deleteUser(row.auth_id); // the users row goes with it (cascade)
          if (del.error) return fail(del.error.message);
        }
        await admin.from('users').delete().eq('id', row.id);
        return json({ id: row.id });
      }

      const v = clean(body);
      if ('error' in v) return fail(v.error as string);
      // The owner keeps email and admin role; nobody changes their own role
      const email = isOwner(row.email) ? row.email : v.email;
      const role = isOwner(row.email) ? 'admin' : row.id === me.id ? row.role : v.role;

      let authId = row.auth_id as string | null;
      if (authId) {
        const attrs: Record<string, unknown> = {};
        if (email.toLowerCase() !== row.email.toLowerCase()) Object.assign(attrs, { email, email_confirm: true });
        if (v.password) attrs.password = v.password;
        if (Object.keys(attrs).length) {
          const up = await admin.auth.admin.updateUserById(authId, attrs);
          if (up.error) return isDup(up.error) ? fail('Email already exists', 409, '23505') : fail(up.error.message);
        }
      } else {
        // Legacy user without a login yet: this is where they get one
        if (!v.password) return fail('Set a password to create this user\'s login', 400, 'password_required');
        const created = await admin.auth.admin.createUser({ email, password: v.password, email_confirm: true });
        if (created.error) {
          const existing = isDup(created.error) ? await findAuthUser(email) : null;
          if (!existing) return isDup(created.error) ? fail('Email already exists', 409, '23505') : fail(created.error.message);
          const up = await admin.auth.admin.updateUserById(existing.id, { password: v.password });
          if (up.error) return fail(up.error.message);
          authId = existing.id;
        } else authId = created.data.user.id;
      }

      const patch: Record<string, unknown> = { name: v.name, email, role, auth_id: authId };
      if ('avatar_url' in body) patch.avatar_url = body.avatar_url || null;
      const upd = await admin.from('users').update(patch).eq('id', row.id).select('id, avatar_url').single();
      if (upd.error) return isDup(upd.error) ? fail('Email already exists', 409, '23505') : fail(upd.error.message);
      return json(upd.data);
    }

    return fail('Unknown action');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Server error', 500);
  }
});
