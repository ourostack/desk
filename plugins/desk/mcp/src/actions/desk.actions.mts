import { defineActions } from "../lib/ouro-actions/ouro-actions.mts";
import { deskSearch, deskRecall, deskSkill } from "./desk-read.actions.mts";
import { taskFocus, deskStatus, deskDoctor, improvementNext } from "./desk-session.actions.mts";

export default defineActions("desk", [deskSearch, deskRecall, deskSkill, deskStatus, deskDoctor, improvementNext, taskFocus], { tool: "desk" });
