let sessionTokenPromise: Promise<string> | undefined;

async function sessionToken(): Promise<string> {
  sessionTokenPromise ??= fetch('/api/session', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('Could not establish a secure local session.');
      const body = await response.json() as { token?: unknown };
      if (typeof body.token !== 'string' || !body.token) {
        throw new Error('The local server returned an invalid session token.');
      }
      return body.token;
    })
    .catch((error) => {
      sessionTokenPromise = undefined;
      throw error;
    });
  return sessionTokenPromise;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const request = async () => {
    const token = await sessionToken();
    const headers = new Headers(init.headers);
    headers.set('X-Chat-Session', token);
    return fetch(input, { ...init, headers });
  };
  let response = await request();
  if (response.status === 401) {
    sessionTokenPromise = undefined;
    response = await request();
  }
  return response;
}
