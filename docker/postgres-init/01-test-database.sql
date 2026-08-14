-- Runs once, on first initialisation of the data volume.
--
-- The test suite requires a database named tally_test and refuses to run
-- against anything else, so creating it here is what makes "clone, pnpm db:up,
-- pnpm test" work for the next person without a documented manual step.
CREATE DATABASE tally_test OWNER tally;
