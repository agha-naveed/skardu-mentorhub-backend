# Entity-relationship diagram

_Generated from the live database by `node scripts/er.mjs` — 36 tables._

Each box lists every column. `PK` primary key, `FK` foreign key.

## Accounts and tutors

```mermaid
erDiagram
  users {
    uuid id PK
    varchar role
    varchar full_name
    varchar email
    varchar phone
    text password
    integer class_level
    ARRAY learning_modes
    varchar avatar
    timestamptz terms_accepted_at
    timestamptz last_login_at
    varchar account_status
    timestamptz created_at
    timestamptz password_changed_at
    varchar academic_field
  }
  tutors {
    uuid id PK
    uuid user_id FK
    varchar centre_name
    varchar qualification
    integer experience_years
    varchar gender
    text bio
    ARRAY teaching_modes
    text address
    numeric latitude
    numeric longitude
    varchar cnic_front
    varchar cnic_back
    varchar qualification_doc
    boolean qualification_verified
    text qualification_note
    timestamptz terms_accepted_at
    jsonb pending_changes
    timestamptz pending_changes_at
    date subscription_paid_until
    boolean listed
    date suspended_until
    varchar verification_status
    text reject_reason
    timestamptz reviewed_at
    uuid reviewed_by FK
    timestamptz created_at
    boolean payment_suspended
    timestamptz payment_suspended_at
    date last_reminder_on
  }
  tutor_subjects {
    uuid id PK
    uuid tutor_id FK
    integer subject_id FK
    integer class_from
    integer class_to
    integer monthly_fee
    ARRAY fields
  }
  tutor_availability {
    uuid id PK
    uuid tutor_id FK
    integer day_of_week
    time_without_time_zone start_time
    time_without_time_zone end_time
  }
  subjects {
    integer id PK
    varchar subject_name
  }
  reviews {
    uuid id PK
    uuid tutor_id FK
    uuid student_id FK
    uuid enrollment_id FK
    integer rating
    text comment
    timestamptz created_at
  }
  reports {
    uuid id PK
    uuid reporter_id FK
    uuid tutor_id FK
    uuid enrollment_id FK
    varchar reason
    text details
    varchar status
    text admin_note
    uuid handled_by FK
    timestamptz handled_at
    timestamptz created_at
  }
  password_resets {
    uuid id PK
    uuid user_id FK
    varchar phone
    text code_hash
    timestamptz expires_at
    integer attempts
    timestamptz used_at
    text reset_hash
    timestamptz reset_expires_at
    timestamptz reset_used_at
    varchar ip
    timestamptz created_at
  }
  users ||--o{ password_resets : has
  users ||--o{ reports : has
  tutors ||--o{ reports : has
  enrollments ||--o{ reports : has
  users ||--o{ reviews : has
  tutors ||--o{ reviews : has
  enrollments ||--o{ reviews : has
  tutors ||--o{ tutor_availability : has
  subjects ||--o{ tutor_subjects : has
  tutors ||--o{ tutor_subjects : has
  users ||--o{ tutors : has
```

## Enrollment and chat

```mermaid
erDiagram
  enrollments {
    uuid id PK
    uuid student_id FK
    uuid tutor_id FK
    text message
    varchar status
    text tutor_note
    timestamptz responded_at
    timestamptz completed_at
    timestamptz created_at
    timestamptz left_at
    text left_reason
    varchar learning_mode
  }
  enrollment_subjects {
    uuid id PK
    uuid enrollment_id FK
    integer subject_id FK
    integer monthly_fee
  }
  messages {
    uuid id PK
    uuid tutor_id FK
    uuid student_id FK
    varchar sender
    text body
    timestamptz read_at
    timestamptz created_at
    text image_url
    timestamptz delivered_at
  }
  announcements {
    uuid id PK
    uuid tutor_id FK
    text body
    timestamptz created_at
  }
  announcement_reads {
    uuid announcement_id PK
    uuid student_id PK
    timestamptz read_at
  }
  notifications {
    uuid id PK
    uuid user_id FK
    varchar type
    varchar title
    text message
    boolean is_read
    timestamptz created_at
    jsonb data
  }
  device_tokens {
    uuid id PK
    uuid user_id FK
    text token
    varchar platform
    timestamptz created_at
    timestamptz last_seen_at
  }
  notification_prefs {
    uuid user_id PK
    boolean messages
    boolean classes
    boolean assignments
    boolean exams
    boolean announcements
    timestamptz updated_at
  }
  users ||--o{ announcement_reads : has
  announcements ||--o{ announcement_reads : has
  tutors ||--o{ announcements : has
  users ||--o{ device_tokens : has
  enrollments ||--o{ enrollment_subjects : has
  subjects ||--o{ enrollment_subjects : has
  users ||--o{ enrollments : has
  tutors ||--o{ enrollments : has
  tutors ||--o{ messages : has
  users ||--o{ messages : has
  users ||--o{ notification_prefs : has
  users ||--o{ notifications : has
```

## Classes and assignments

```mermaid
erDiagram
  class_sessions {
    uuid id PK
    uuid tutor_id FK
    integer subject_id FK
    varchar title
    timestamptz starts_at
    timestamptz ends_at
    varchar mode
    text location
    text meeting_link
    varchar status
    text cancel_reason
    timestamptz reminder_sent_at
    timestamptz created_at
    timestamptz updated_at
  }
  class_session_students {
    uuid session_id PK
    uuid student_id PK
  }
  attendance {
    uuid session_id PK
    uuid student_id PK
    timestamptz check_in_at
    timestamptz check_out_at
    varchar marked_by
  }
  assignments {
    uuid id PK
    uuid tutor_id FK
    integer subject_id FK
    varchar title
    text description
    text attachment_url
    varchar attachment_name
    timestamptz due_at
    integer max_marks
    boolean allow_late
    timestamptz reminder_sent_at
    timestamptz created_at
  }
  assignment_students {
    uuid assignment_id PK
    uuid student_id PK
  }
  assignment_submissions {
    uuid id PK
    uuid assignment_id FK
    uuid student_id FK
    text answer_text
    text file_url
    varchar file_name
    timestamptz submitted_at
    boolean is_late
    integer marks
    text feedback
    timestamptz marked_at
  }
  users ||--o{ assignment_students : has
  assignments ||--o{ assignment_students : has
  assignments ||--o{ assignment_submissions : has
  users ||--o{ assignment_submissions : has
  tutors ||--o{ assignments : has
  subjects ||--o{ assignments : has
  class_sessions ||--o{ attendance : has
  users ||--o{ attendance : has
  users ||--o{ class_session_students : has
  class_sessions ||--o{ class_session_students : has
  subjects ||--o{ class_sessions : has
  tutors ||--o{ class_sessions : has
```

## Exams

```mermaid
erDiagram
  quizzes {
    uuid id PK
    uuid tutor_id FK
    integer subject_id FK
    varchar title
    text description
    integer class_from
    integer class_to
    integer time_limit_mins
    boolean is_published
    timestamptz created_at
    integer seconds_per_question
  }
  quiz_questions {
    uuid id PK
    uuid quiz_id FK
    text question_text
    integer order_index
    integer points
  }
  quiz_options {
    uuid id PK
    uuid question_id FK
    text option_text
    boolean is_correct
    integer order_index
  }
  quiz_releases {
    uuid quiz_id PK
    uuid student_id PK
    date release_on
    timestamptz created_at
  }
  quiz_attempts {
    uuid id PK
    uuid quiz_id FK
    uuid student_id FK
    timestamptz started_at
    timestamptz submitted_at
    integer score
    integer max_score
    integer current_index
    timestamptz question_started_at
    integer cheat_count
  }
  quiz_answers {
    uuid attempt_id PK
    uuid question_id PK
    uuid option_id FK
    boolean is_correct
    boolean cheated
    boolean timed_out
    timestamptz answered_at
  }
  exam_cheat_events {
    bigint id PK
    uuid attempt_id FK
    uuid quiz_id FK
    uuid student_id FK
    uuid question_id FK
    varchar kind
    timestamptz occurred_at
  }
  quiz_questions ||--o{ exam_cheat_events : has
  quiz_attempts ||--o{ exam_cheat_events : has
  quizzes ||--o{ exam_cheat_events : has
  users ||--o{ exam_cheat_events : has
  quiz_attempts ||--o{ quiz_answers : has
  quiz_questions ||--o{ quiz_answers : has
  quiz_options ||--o{ quiz_answers : has
  users ||--o{ quiz_attempts : has
  quizzes ||--o{ quiz_attempts : has
  quiz_questions ||--o{ quiz_options : has
  quizzes ||--o{ quiz_questions : has
  quizzes ||--o{ quiz_releases : has
  users ||--o{ quiz_releases : has
  tutors ||--o{ quizzes : has
  subjects ||--o{ quizzes : has
```

## Videos

```mermaid
erDiagram
  videos {
    uuid id PK
    uuid tutor_id FK
    integer subject_id FK
    varchar title
    text description
    text url
    varchar source
    text cloud_id
    text thumbnail
    bigint size_bytes
    integer class_from
    integer class_to
    integer duration_mins
    timestamptz created_at
    varchar academic_field
    integer duration_seconds
  }
  video_releases {
    uuid video_id PK
    uuid student_id PK
    date release_on
    timestamptz watched_at
    integer watched_seconds
    integer watch_count
    timestamptz last_watched_at
    timestamptz created_at
  }
  videos ||--o{ video_releases : has
  users ||--o{ video_releases : has
  subjects ||--o{ videos : has
  tutors ||--o{ videos : has
```

## Payments and settings

```mermaid
erDiagram
  payments {
    uuid id PK
    uuid tutor_id FK
    integer amount
    varchar method
    varchar reference
    text note
    varchar receipt
    varchar status
    text admin_note
    uuid handled_by FK
    timestamptz handled_at
    timestamptz created_at
    date for_month
  }
  app_settings {
    varchar key PK
    jsonb value
    uuid updated_by FK
    timestamptz updated_at
  }
  users ||--o{ app_settings : has
  users ||--o{ payments : has
  tutors ||--o{ payments : has
```

## Audit

```mermaid
erDiagram
  activity_log {
    bigint id PK
    uuid user_id FK
    varchar user_name
    varchar user_role
    varchar action
    text detail
    timestamptz created_at
    varchar ip
  }
  users ||--o{ activity_log : has
```

## Other

```mermaid
erDiagram
  coverage_areas {
    uuid id PK
    varchar name
    jsonb polygon
    numeric center_lat
    numeric center_lng
    uuid created_by FK
    timestamptz created_at
    timestamptz updated_at
  }
  video_watch_sessions {
    uuid id PK
    uuid video_id FK
    uuid student_id FK
    timestamptz started_at
    timestamptz last_seen_at
    integer seconds
    integer max_position_seconds
    boolean completed
    varchar method
  }
  users ||--o{ coverage_areas : has
  users ||--o{ video_watch_sessions : has
  videos ||--o{ video_watch_sessions : has
```

