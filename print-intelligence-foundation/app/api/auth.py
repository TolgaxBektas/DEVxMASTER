from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from app.core.config import get_settings

bearer = HTTPBearer(auto_error=False)


def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer),
):
    settings = get_settings()
    if settings.auth_disabled:
        return
    if not credentials or credentials.credentials != settings.service_token:
        raise HTTPException(401, "authentication required")
