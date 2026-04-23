# Test Patterns Reference

Примеры и паттерны генерации тестов для каждого языка. Следуй этим правилам при написании тестов.

---

## Общие принципы (ALL languages)

### DO ✅
- Тестируй **public API** — не тестируй private/internal implementation
- Каждый тест — **одна проверка** (single assertion per test, or closely related group)
- Naming: `should_ExpectedBehavior_When_StateUnderTest` (Kotlin/Java) или `it('should do X when Y')` (TS) или `test_description` (Python)
- AAA pattern: **Arrange → Act → Assert**
- Тестируй edge cases: null, empty, boundary values, error paths
- Используй **настоящие данные** для arrange — не случайные строки

### DON'T ❌
- НЕ мокай всё подряд — мокай только внешние зависимости (API, DB, file system)
- НЕ тестируй тривиальный код (getters, data classes without logic)
- НЕ пиши тесты которые всегда pass (no assertions)
- НЕ используй `Thread.sleep()` — используй await/suspend или timeouts
- НЕ тестируй фреймворк — тестируй свой код

### Генерация тестов: процесс

1. **Прочитай исходный код** целевого модуля полностью
2. **Определи public API**: функции, методы, свойства
3. **Определи зависимости**: что нужно мокать, что использовать как есть
4. **Для каждого public метода** — определи:
   - Happy path (нормальный сценарий)
   - Error path (ошибки, исключения)
   - Edge cases (пустые данные, boundary values)
5. **Проверь существующие тесты** в проекте — следуй их стилю
6. **Напиши тесты** используя правильные импорты и аннотации

---

## Kotlin (JUnit5 + MockK)

### Template

```kotlin
package com.example.module  // должен совпадать с source package

import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Nested
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.jupiter.api.assertThrows
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@DisplayName("FeatureService")
class FeatureServiceTest {

    // --- System Under Test ---
    private lateinit var service: FeatureService

    // --- Dependencies (mocks) ---
    private val repository: FeatureRepository = mockk()
    private val logger: Logger = mockk(relaxed = true)

    @BeforeEach
    fun setup() {
        service = FeatureService(repository, logger)
    }

    @Nested
    @DisplayName("performAction")
    inner class PerformAction {

        @Test
        @DisplayName("should return result when input is valid")
        fun `should return result when input is valid`() {
            // Arrange
            every { repository.findById(1L) } returns createFeature(id = 1L)

            // Act
            val result = service.performAction(1L)

            // Assert
            assertEquals(expected = "result", actual = result)
            verify(exactly = 1) { repository.findById(1L) }
        }

        @Test
        @DisplayName("should throw when entity not found")
        fun `should throw when entity not found`() {
            // Arrange
            every { repository.findById(99L) } returns null

            // Act & Assert
            assertThrows<NotFoundException> {
                service.performAction(99L)
            }
        }
    }
}

// --- Helper functions (private, not tests) ---
private fun createFeature(id: Long = 1L, name: String = "test") = Feature(id = id, name = name)
```

### Kotest style (если проект использует Kotest)

```kotlin
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

class FeatureServiceTest : StringSpec({
    val repository = mockk<FeatureRepository>()
    val service = FeatureService(repository)

    "should return result when input is valid" {
        every { repository.findById(1L) } returns createFeature()
        service.performAction(1L) shouldBe "result"
    }
})
```

### Key imports detection

```bash
# JUnit5
grep -r "org.junit.jupiter" build.gradle.kts → use JUnit5 style

# Kotest
grep -r "io.kotest" build.gradle.kts → use Kotest style

# MockK
grep -r "io.mockk" build.gradle.kts → use MockK for mocking

# Mockito
grep -r "org.mockito" build.gradle.kts → use Mockito for mocking
```

---

## TypeScript (Jest)

### Template

```typescript
import { FeatureService } from './feature-service';
import { FeatureRepository } from '../repositories/feature-repository';

// Mock dependencies
jest.mock('../repositories/feature-repository');

const mockRepository = new FeatureRepository() as jest.Mocked<FeatureRepository>;

describe('FeatureService', () => {
  let service: FeatureService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FeatureService(mockRepository);
  });

  describe('performAction', () => {
    it('should return result when input is valid', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({ id: 1, name: 'test' });

      // Act
      const result = await service.performAction(1);

      // Assert
      expect(result).toBe('result');
      expect(mockRepository.findById).toHaveBeenCalledWith(1);
      expect(mockRepository.findById).toHaveBeenCalledTimes(1);
    });

    it('should throw when entity not found', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.performAction(99)).rejects.toThrow(NotFoundException);
    });
  });
});
```

### Vitest style (почти идентичен Jest, другие импорты)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeatureService } from './feature-service';

vi.mock('../repositories/feature-repository', () => ({
  FeatureRepository: vi.fn(),
}));

describe('FeatureService', () => {
  // ... same structure
});
```

---

## Python (pytest)

### Template

```python
import pytest
from module.feature_service import FeatureService
from module.repositories import FeatureRepository


@pytest.fixture
def mock_repository():
    """Create a mock repository."""
    repo = FeatureRepository()
    repo.find_by_id = pytest.mock.AsyncMock(return_value={"id": 1, "name": "test"})
    return repo


@pytest.fixture
def service(mock_repository):
    """Create service with mocked dependencies."""
    return FeatureService(mock_repository)


class TestFeatureService:
    """Tests for FeatureService.perform_action."""

    def test_should_return_result_when_input_is_valid(self, service, mock_repository):
        # Arrange
        mock_repository.find_by_id.return_value = {"id": 1, "name": "test"}

        # Act
        result = service.perform_action(1)

        # Assert
        assert result == "result"
        mock_repository.find_by_id.assert_called_once_with(1)

    def test_should_raise_when_entity_not_found(self, service, mock_repository):
        # Arrange
        mock_repository.find_by_id.return_value = None

        # Act & Assert
        with pytest.raises(NotFoundError):
            service.perform_action(99)
```

### Key patterns
- `pytest.fixture` для setup (заменяет `@BeforeEach`)
- `pytest.mock.Mock` / `AsyncMock` для моков
- `pytest.raises(Exception)` для проверки exceptions
- `@pytest.mark.parametrize` для параметризованных тестов

---

## Rust

### Unit tests (in-source)

```rust
// Добавить в конец файла модуля:

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_return_result_when_input_is_valid() {
        let mut service = FeatureService::new();
        let result = service.perform_action(1);
        assert_eq!(result, Some("result".to_string()));
    }

    #[test]
    #[should_panic(expected = "not found")]
    fn should_panic_when_entity_not_found() {
        let service = FeatureService::new();
        let _ = service.perform_action(99);
    }

    #[test]
    fn should_handle_empty_input() {
        let service = FeatureService::new();
        let result = service.process("");
        assert!(result.is_empty());
    }
}
```

### Integration tests (separate file: tests/integration_test.rs)

```rust
use my_crate::FeatureService;

#[test]
fn integration_should_work_end_to_end() {
    let service = FeatureService::new();
    let result = service.perform_action(1);
    assert!(result.is_ok());
}
```

---

## Go

### Template

```go
package module_test

import (
    "testing"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "myproject/module"
    "myproject/repositories"
)

// Mock implementation
type MockRepository struct {
    mock.Mock
}

func (m *MockRepository) FindByID(id int) (*module.Feature, error) {
    args := m.Called(id)
    if args.Get(0) == nil {
        return nil, args.Error(1)
    }
    return args.Get(0).(*module.Feature), args.Error(1)
}

func TestFeatureService_PerformAction(t *testing.T) {
    t.Run("should return result when input is valid", func(t *testing.T) {
        // Arrange
        mockRepo := new(MockRepository)
        mockRepo.On("FindByID", 1).Return(&module.Feature{ID: 1}, nil)
        service := module.NewFeatureService(mockRepo)

        // Act
        result, err := service.PerformAction(1)

        // Assert
        assert.NoError(t, err)
        assert.Equal(t, "result", result)
        mockRepo.AssertExpectations(t)
    })
}
```

---

## Edge Cases Checklist

Для каждого модуля проверь наличие тестов для:

| Тип | Пример |
|-----|--------|
| Normal input | Валидные данные, типичный сценарий |
| Empty / zero | `""`, `0`, `[]`, `null`, `None` |
| Boundary | `Int.MAX_VALUE`, `Int.MIN_VALUE`, empty string, single char |
| Error path | External dep returns error, network failure, file not found |
| Null/None input | Nullable parameters |
| Duplicate data | Дублирующиеся записи в коллекции |
| Concurrent access | Если есть shared state (skip если простой синхронный код) |
| Large input | Большой список/строка (basic check, не performance) |
