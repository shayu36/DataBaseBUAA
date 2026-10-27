export function pageById(rows, key) {
  const hasMore = rows.length > 100;
  if (hasMore) rows.pop();
  return { [key]: rows, next_before: hasMore ? rows.at(-1).id : null };
}
