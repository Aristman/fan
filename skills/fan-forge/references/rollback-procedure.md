# Rollback Procedure

Полная процедура отката при ошибке деплоя extension/skill:

```
1. Обнаружена ошибка (reload failed / tool not available / runtime error)
2. rm -rf <target>/<name>                           # удалить неработающий
3. ls <target>/<name>.bak.* | tail -1                # найти последний backup
4. mv <backup> <target>/<name>                       # восстановить
5. Отправить /reload                                 # перезагрузить fan
6. Верифицировать восстановление
7. Сообщить пользователю об ошибке и rollback
```

**Target paths:**
- Extension глобально: `~/.fan/agent/extensions/<name>/`
- Extension проектно: `.fan/extensions/<name>/`
- Skill глобально: `~/.fan/agent/skills/<name>/`
- Skill проектно: `.fan/skills/<name>/`
