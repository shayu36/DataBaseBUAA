export function sessionSecret() {
  const value = process.env.JWT_SECRET;
  if (
    !value ||
    value.length < 32 ||
    !value.trim() ||
    value.trimStart().startsWith("replace-with-")
  )
    throw new Error(
      "JWT_SECRET 至少需要 32 个字符，且不能使用示例占位符或空白值。",
    );
  return value;
}
