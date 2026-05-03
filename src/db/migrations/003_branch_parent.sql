alter table branches add column parent_branch_id integer references branches(id) on delete set null;
