---
description: Implement then verify, with fix round if needed
---
Use the delegate_task tool with the chain parameter to execute this workflow:

1. First, use the "implement" agent to implement: $@
2. Then, use the "verify" agent to review the implementation from the previous step (use {previous} placeholder)
3. Finally, use the "implement" agent to apply any feedback from the review (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
