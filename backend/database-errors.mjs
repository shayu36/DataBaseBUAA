export function databaseStartupError(error, { account = "application" } = {}) {
  const address = `${process.env.DB_HOST || "127.0.0.1"}:${process.env.DB_PORT || "3306"}`;
  let message;
  switch (error?.code) {
    case "ECONNREFUSED":
      message = `无法连接 MySQL ${address}（ECONNREFUSED）。请先安装并启动 MySQL Server，并核对 .env 中的 DB_HOST、DB_PORT。npm ci 不会安装数据库。Windows 可运行 services.msc 检查 MySQL 服务；详见 README 的 Windows 首次配置说明。`;
      break;
    case "ETIMEDOUT":
      message = `连接 MySQL ${address} 超时，请检查数据库服务、DB_HOST、DB_PORT 及网络。`;
      break;
    case "ENOTFOUND":
      message = "无法解析 MySQL 地址，请检查 .env 中的 DB_HOST。";
      break;
    case "ER_ACCESS_DENIED_ERROR":
    case "ER_ACCESS_DENIED_NO_PASSWORD_ERROR":
      message =
        account === "administrator"
          ? "MySQL 管理员认证失败。请核对 .env 中的 DB_ADMIN_USER、DB_ADMIN_PASSWORD：填写 MySQL 管理员账号（通常为 root）和安装数据库时设置的密码，不能使用网页演示账号。"
          : account === "both"
            ? "MySQL 认证失败。模拟导入同时需要数据库应用账号 DB_USER、DB_PASSWORD 和管理员账号 DB_ADMIN_USER、DB_ADMIN_PASSWORD，请分别核对；这些账号不是网页演示账号。"
            : "MySQL 应用账号认证失败。请核对 .env 中的 DB_USER、DB_PASSWORD；首次使用先运行 npm run db:seed，已有数据库账号的密码不会被初始化命令覆盖。";
      break;
    case "ER_BAD_DB_ERROR":
      message =
        "项目数据库尚未创建。请先启动 MySQL、填写正确的管理员凭据，再运行 npm run db:seed；成功后再导入模拟数据或启动应用。";
      break;
    default:
      return error;
  }
  return Object.assign(new Error(message), { code: error.code });
}
