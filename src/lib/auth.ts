import { createAuthClient } from "@neondatabase/neon-js/auth";

const rawBase = import.meta.env.VITE_NEON_AUTH_URL as string;
const baseURL = rawBase.startsWith("/") ? window.location.origin + rawBase : rawBase;

export const authClient = createAuthClient(baseURL);
