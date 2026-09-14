import { redirect } from '@sveltejs/kit';

/** The public entry point is always the student portal. Teachers use /teacher. */
export function load(): never { throw redirect(302, '/student'); }
