# Decisions

### ADR-F-001
- **Date**: 2026-08-10
- **Status**: accepted
- **Context**: Need a deterministic mission fixture for F-15 integration tests
- **Decision**: Create test/fixtures/mission/sample with 5 valid mission files
- **Consequences**: Integration tests can validate file-state-manager parses fixture data without errors

### ADR-F-002
- **Date**: 2026-08-11
- **Status**: accepted
- **Context**: Mission-loop integration with scheduler and webhook requires mock environment
- **Decision**: Introduce MockMissionEnvironment helper that wires missionLoop + scheduler + webhook + actions
- **Consequences**: Future tests can reuse the helper; integration scenarios become testable