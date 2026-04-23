---
name: TodoMVC App
url: https://demo.playwright.dev/todomvc
tags: [critical, smoke]
viewport: 1280x720
---

# TodoMVC Smoke Test

## Step 1: Open TodoMVC
- action: navigate
  url: https://demo.playwright.dev/todomvc
- expect:
    - element_visible: heading "todos"
    - element_visible: textbox "What needs to be done?"
    - url_contains: todomvc

## Step 2: Add First Todo
- action: type
  ref: textbox "What needs to be done?"
  text: Buy groceries
  submit: true
- expect:
    - text_visible: "Buy groceries"
    - element_visible: text "1 item left"

## Step 3: Add Second Todo
- action: type
  ref: textbox "What needs to be done?"
  text: Clean the house
  submit: true
- expect:
    - text_visible: "Buy groceries"
    - text_visible: "Clean the house"
    - element_visible: text "2 items left"

## Step 4: Toggle First Todo
- action: click
  ref: checkbox "Toggle Todo"
- expect:
    - element_visible: text "1 item left"

## Step 5: Filter Active Todos
- action: click
  ref: link "Active"
- expect:
    - not_text_visible: "Buy groceries"
    - text_visible: "Clean the house"

## Step 6: Filter Completed Todos
- action: click
  ref: link "Completed"
- expect:
    - text_visible: "Buy groceries"
    - not_text_visible: "Clean the house"

## Step 7: Delete Todo
- action: hover
  ref: listitem "Buy groceries"
- action: click
  ref: button "Delete"
- expect:
    - not_text_visible: "Buy groceries"
    - element_visible: text "1 item left"
- screenshot: after_delete
