"""FastAPI dependencies: app context."""
from typing import Annotated

from fastapi import Depends, Request


def ctx(request: Request):
    return request.app.state.ctx


Ctx = Annotated[object, Depends(ctx)]

__all__ = ['Ctx', 'ctx']
