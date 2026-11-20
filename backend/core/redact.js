// Anything that can reach go-antigravity.log, accounts.json or the UI console passes through here.
//
// Why this exists: child_process failures are reported as "Command failed: <full command
// line>", and our curl calls carry the OAuth client secret and the account's refresh token as
// arguments. A single unreachable proxy used to write both secrets into the log file and into
// the account's error field - and the same is true for the Authorization headers of the quota
// calls. Redact at the choke points instead of trusting every call site to be careful.
const MASK = '***';

const RULES = [
  // Named tunnel credentials in structured settings, environment echoes or CLI diagnostics.
  [/(["']?(?:tunnel[_-]?token|cf[_-]tunnel[_-]?token|cloudflared[_-]token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,};&]+)/gi, (_match, prefix) => prefix + MASK],
  [/(--token(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, (_match, prefix) => prefix + MASK],
  // key=value form (curl --data-urlencode / form-encoded bodies)
  [/\b(client_secret|refresh_token|access_token|id_token|code)=([^\s'"&]+)/gi, (_match, key) => `${key}=${MASK}`],
  // JSON form ({"refresh_token":"1//..."})
  [/"(client_secret|refresh_token|access_token|id_token|code)"\s*:\s*"[^"]*"/gi, (_match, key) => `"${key}":"${MASK}"`],
  // Authorization headers echoed back by curl - any scheme, not just Bearer
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{10,}/gi, (_match, scheme) => `${scheme} ${MASK}`],
  // Authorization header: mask only the value, and only when it still looks like a
  // credential (scheme + token). A bare "authorization: true" or a JSON field must survive.
  [/\b(authorization)\s*:\s*(Bearer|Basic|Token)\s+[^\r\n]+/gi,
    (_match, key, scheme) => `${key}: ${scheme} ${MASK}`],
  // Cookie request/response headers: mask only when a real cookie pair follows, so a JSON
  // object containing a "cookie" field is not swallowed line by line.
  [/\b(set-cookie|cookie)\s*:\s*(?=[^\r\n]*[\w-]+\s*=\s*[^\s;]+)[^\r\n]+/gi,
    (_match, key) => `${key}: ${MASK}`],
  // Cookie name=value pairs inside a Cookie header or a structured log field
  [/\b([\w-]*(?:session[_-]?id|sid|csrf[_-]?xsrf[_-]?token|xsrf[_-]?token|auth[_-]?token|jwt))\s*=\s*[^;\s"']+/gi,
    (_match, key) => `${key}=${MASK}`],
  // Structured keys keep valid JSON and mask the complete quoted value.
  [/"((?:x-api-key|api[_-]?key|apikey|secret[_-]?key|webhook[_-]?secret|private[_-]?key))"\s*:\s*"(?:\\.|[^"\\])*"/gi, (_match, key) => `"${key}":"${MASK}"`],
  // API keys and webhook secrets in key=value form (x-api-key, api_key, apikey, webhook secret)
  [/\b(x-api-key|api[_-]?key|apikey|secret[_-]?key|webhook[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[^\s"',;&}]+/gi,
    (_match, key) => `${key}=${MASK}`],
  // JWTs stand alone in logs without any key name around them
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, `jwt.${MASK}`],
  // A bare "token" key whose value looks like a credential (not the literal word "token").
  // Matches with or without the surrounding quotes, with or without spaces, so both the
  // compact {"token":"..."} and the pretty {"token": "..."} forms are handled. The key name
  // is kept so the log stays readable and redaction stays idempotent.
  [/"?(token)"?\s*:\s*"([A-Za-z0-9._~+/=-]{16,})"/gi, (_match, key) => `"${key}":"${MASK}"`],
  [/\b(token)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{16,})["']?/gi, (_match, key) => `${key}=${MASK}`],
  // Google credential shapes that survive on their own
  [/\bGOCSPX-[A-Za-z0-9_-]{10,}/g, 'GOCSPX-***'],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, 'ya29.***'],
  [/\b1\/\/[A-Za-z0-9_-]{10,}/g, match => `${match.slice(0, 5)}…${match.slice(-4)}`]
];

function redactSecrets(input) {
  let text = typeof input === 'string' ? input : String(input ?? '');
  if (!text) return text;
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  return text;
}

// True when a string still carries something that looks like a credential; used by tests and
// by the log rotation guard to avoid persisting an unsanitised line.
function containsSecret(input) {
  let text = typeof input === 'string' ? input : String(input ?? '');
  if (!text) return false;
  // Mask anything already rewritten before sniffing: a rule that turns "cookie: <value>" into
  // "cookie: ***" would otherwise keep matching its own output and report a secret that is
  // no longer present. The Authorization rule rewrites "Bearer <token>" to "Bearer ***", so
  // the scheme must go too or the header check below would keep matching its own output.
  text = text.split(MASK).join(' ')
    .replace(/\b(?:Bearer|Basic|Token)\s*$/gi, '')
    .replace(/\b(authorization|set-cookie|cookie)\s*:\s*$/gi, '');
  return /(?:["']?(?:tunnel[_-]?token|cf[_-]tunnel[_-]?token|cloudflared[_-]token)["']?\s*[:=]\s*["']?|--token(?:=|\s+)["']?)[^\s"'*,};&]{1,}/i.test(text)
    || /\bGOCSPX-[A-Za-z0-9_-]{10,}/.test(text)
    || /\bya29\.[A-Za-z0-9._-]{10,}/.test(text)
    || /\b1\/\/[A-Za-z0-9_-]{10,}/.test(text)
    || /(?:client_secret|refresh_token|access_token|id_token)=[^\s'"&*]{8,}/i.test(text)
    || /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{10,}/i.test(text)
    || /"token"\s*:\s*"[A-Za-z0-9._~+/=-]{16,}"/i.test(text)
    || /\btoken\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}["']?/i.test(text)
    || /\bauthorization\s*:\s*(?:Bearer|Basic|Token)\s+[^\r\n]+/i.test(text)
    || /\b(?:set-cookie|cookie)\s*:\s*(?=[^\r\n]*[\w-]+\s*=\s*[^\s;]+)[^\r\n]+/i.test(text)
    || /\b[\w-]*(?:session[_-]?id|csrf[_-]?xsrf[_-]?token|xsrf[_-]?token|auth[_-]?token|jwt)\s*=\s*[^;\s"']+/i.test(text)
    || /\b(?:x-api-key|api[_-]?key|apikey|secret[_-]?key|webhook[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[^\s"',;&}]+/i.test(text)
    || /"(?:x-api-key|api[_-]?key|apikey|secret[_-]?key|webhook[_-]?secret|private[_-]?key)"\s*:\s*"[^"\s][^"]*"/i.test(text)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/.test(text);
}

module.exports = { redactSecrets, containsSecret, MASK };
