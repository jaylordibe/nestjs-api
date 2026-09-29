-- Account lockout is replaced by an identifier + IP login throttle.
ALTER TABLE "users" DROP COLUMN "failed_login_count",
DROP COLUMN "locked_until";
