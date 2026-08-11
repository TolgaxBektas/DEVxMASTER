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
    bearer_valid = credentials and credentials.credentials == settings.service_token
    header_valid = service_token == settings.service_token
    if not bearer_valid and not header_valid:
        raise HTTPException(401, "authentication required")
