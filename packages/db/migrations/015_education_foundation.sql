-- Education foundation, isolated from execution submissions and interview rooms.
CREATE TABLE education_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,project_id)
);
CREATE INDEX education_courses_project_idx ON education_courses(project_id,created_at DESC);

CREATE TABLE education_enrollments (
  course_id uuid NOT NULL REFERENCES education_courses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id,user_id)
);
CREATE INDEX education_enrollments_user_idx ON education_enrollments(user_id,enrolled_at DESC);

CREATE TABLE education_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES education_courses(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  instructions text NOT NULL DEFAULT '',
  challenge_id uuid REFERENCES challenges(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  due_at timestamptz,
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,course_id)
);
CREATE INDEX education_assignments_course_idx ON education_assignments(course_id,created_at DESC);
CREATE INDEX education_assignments_due_idx ON education_assignments(due_at) WHERE status='published';
