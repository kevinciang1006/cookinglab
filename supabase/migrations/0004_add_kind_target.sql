alter table attempts add column if not exists kind text default 'attempt';
alter table attempts add column if not exists target text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'attempts_kind_check'
  ) then
    alter table attempts
      add constraint attempts_kind_check
      check (kind in ('attempt','experiment','note'));
  end if;
end $$;
