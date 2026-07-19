ALTER TABLE list_items ADD COLUMN assignment TEXT CHECK(assignment IN ('shared', 'carsonpauli', 'jessipauli'));
