# IPC Protocol

JSON line protocol:
- Request `Ping` -> Response `Pong`
- Request `SaveConversation` -> Response `Ok`
- Request `SaveSnapshot` -> Response `Ok`
- Request `GetConversations` -> Response `Data`
- Request `Recover` -> Response `Data`
- Request `RunStateRepair` -> Response `Data` (`RecoveryReport`)
- Request `ReadFile` -> Response `Data`
- Request `WriteFile` -> Response `Data`
- Request `EditFile` -> Response `Data`
