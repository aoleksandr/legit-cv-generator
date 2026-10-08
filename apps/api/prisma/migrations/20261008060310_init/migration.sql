-- CreateEnum
CREATE TYPE "CvStatus" AS ENUM ('queued', 'processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('pdf', 'text');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('open', 'answered', 'dismissed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cvs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "target_role" TEXT NOT NULL,
    "source_type" "SourceType" NOT NULL,
    "source_text" TEXT NOT NULL,
    "content" JSONB,
    "facts" JSONB NOT NULL DEFAULT '[]',
    "status" "CvStatus" NOT NULL DEFAULT 'queued',
    "progress_step" TEXT,
    "error" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cvs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cv_questions" (
    "id" UUID NOT NULL,
    "cv_id" UUID NOT NULL,
    "field_path" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "status" "QuestionStatus" NOT NULL DEFAULT 'open',
    "applying" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cv_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "cvs_user_id_updated_at_idx" ON "cvs"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "cv_questions_cv_id_idx" ON "cv_questions"("cv_id");

-- AddForeignKey
ALTER TABLE "cvs" ADD CONSTRAINT "cvs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cv_questions" ADD CONSTRAINT "cv_questions_cv_id_fkey" FOREIGN KEY ("cv_id") REFERENCES "cvs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
