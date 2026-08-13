from fastapi import HTTPException, Security
from fastapi.security import (
    APIKeyHeader,
    HTTPAuthorizationCredentials,
    HTTPBearer,
)
from app.core.config import get_settings

bearer = HTTPBearer(auto_error=False)
service_token_header = APIKeyHeader(name="x-service-token", auto_error=False)


def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer),
):
    settings = get_settings()
    if settings.auth_disabled:
        return
    if not credentials or credentials.credentials != settings.service_token:
        raise HTTPException(401, "authentication required")


def require_compat_auth(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer),
    service_token: str | None = Security(service_token_header),
):
    settings = get_settings()
    if settings.auth_disabled:
        return
    configured_token = settings.service_token
    bearer_valid = bool(
        configured_token
        and credentials
        and credentials.credentials == configured_token
    )
    header_valid = bool(configured_token and service_token == configured_token)
    if not bearer_valid and not header_valid:
        raise HTTPException(401, "authentication required")
