# Authentication transport boundary

This listener sets `HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` session
cookies. It intentionally omits `Secure`: this product's supported deployment
is a teacher-confirmed private LAN over HTTP, where a Secure cookie would not
be sent. Consequently HTTP does **not** protect credentials or session tokens
from a hostile machine on that LAN; deployment to the Internet, a public
network, proxy, or an untrusted segment is unsupported.

POST routes require their explicitly configured same `Origin`; authenticated
POST logout additionally requires an HMAC CSRF value derived from the raw
session token and an injected server secret. The raw token exists only in the
HttpOnly cookie and is never persisted: SQLite stores its SHA-256 hash.
