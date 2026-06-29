/** Конфигурация loop-цикла */
export interface LoopConfig {
  /** Максимальное количество итераций (default 10) */
  maxIterations: number;
  /** Модель для выполнения задачи */
  model?: string;
}

/** Состояние loop-цикла */
export interface LoopState {
  /** Уникальный ID цикла */
  id: string;
  /** Описание задачи */
  task: string;
  /** Критерии приёмки */
  criteria: string;
  /** Конфигурация */
  config: LoopConfig;
  /** Текущий статус */
  status: "running" | "paused" | "completed" | "failed" | "aborted";
  /** Список итераций */
  iterations: LoopIteration[];
  /** Время запуска (timestamp ms) */
  startedAt: number;
  /** Время завершения (timestamp ms) */
  completedAt?: number;
  /** Финальный вердикт */
  finalVerdict?: string;
}

/** Одна итерация loop-цикла */
export interface LoopIteration {
  /** Номер итерации (1-based) */
  number: number;
  /** Статус итерации */
  status: "pending" | "running" | "completed" | "failed";
  /** Текстовый результат итерации */
  result?: string;
  /** Вердикт проверки критериев */
  verdict?: "pass" | "fail" | "partial";
  /** Ошибка, если есть */
  error?: string;
  /** Время начала (timestamp ms) */
  startedAt: number;
  /** Время завершения (timestamp ms) */
  completedAt?: number;
  /** Количество попыток внутри итерации */
  attemptCount: number;
}

/** Результат парсинга аргументов команды /loop */
export interface ParsedLoopArgs {
  task?: string;
  criteria?: string;
  maxIterations?: number;
  model?: string;
  interactive?: boolean;
  help?: boolean;
}
