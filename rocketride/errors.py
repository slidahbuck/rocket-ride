"""Expected failures exposed by the connector's result contract."""


class ConnectorError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
