ALTER TABLE list_items ADD COLUMN assignee TEXT CHECK(assignee IN ('carsonpauli', 'jessipauli'));
