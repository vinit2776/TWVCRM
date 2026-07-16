-- Add managed and enterprise to workspace_type enum
ALTER TYPE workspace_type ADD VALUE IF NOT EXISTS 'managed';
ALTER TYPE workspace_type ADD VALUE IF NOT EXISTS 'enterprise';
