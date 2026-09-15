-- Upgrade the self-improvement loop: suggestions become CLEAR, ACTIONABLE
-- change requests a coding agent can implement directly — with acceptance
-- criteria, rough effort, a priority, and the area of the app affected.

alter table suggestions
  add column if not exists acceptance text,   -- how we'll know it's done (bullets)
  add column if not exists effort     text,   -- 'small' | 'medium' | 'large'
  add column if not exists priority   text,   -- 'low' | 'medium' | 'high'
  add column if not exists area       text;   -- chat | journal | coach | items | calendar | notifications | other
