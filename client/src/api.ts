export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'x-kuna-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth')) window.dispatchEvent(new Event('kuna:unauthorized'));
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T = any>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T = any>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T = any>(url: string) => request<T>('DELETE', url),
};
