export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined
      ? { method: "POST", body: JSON.stringify(body) }
      : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      (data.error || "请求失败") + (data.code ? " (" + data.code + ")" : ""),
    );
  return data;
}
