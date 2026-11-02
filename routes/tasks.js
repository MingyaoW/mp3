const User = require("../models/user");
const express = require("express");
const mongoose = require("mongoose");
const Task = require("../models/task");
const { validateTask, isValidId, parseSelect, parseCollectionQuery } = require("../utils/validation");
const router = express.Router();

class RequestError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  
  async function resolveAssignment(body, session) {
    const assignedUser = body.assignedUser ?? "";
  
    if (assignedUser === "") {
      if (
        body.assignedUserName !== undefined &&
        body.assignedUserName !== "unassigned"
      ) {
        throw new RequestError(
          400,
          "assignedUserName must be unassigned"
        );
      }
  
      return {
        assignedUser: "",
        assignedUserName: "unassigned"
      };
    }
  
    if (!isValidId(assignedUser)) {
      throw new RequestError(400, "Invalid assignedUser ID");
    }
  
    const user = await User.findById(assignedUser).session(session);
  
    if (!user) {
      throw new RequestError(404, "Assigned user not found");
    }
  
    if (
      body.assignedUserName !== undefined &&
      body.assignedUserName !== user.name
    ) {
      throw new RequestError(
        400,
        "assignedUserName does not match assignedUser"
      );
    }
  
    return {
      assignedUser: user._id.toString(),
      assignedUserName: user.name
    };
  }


// GET /api/tasks
router.get("/", async (req, res) => {
    let options;
  
    try {
      options = parseCollectionQuery(req.query, 100);
    } catch (err) {
      return res.status(400).json({
        message: err.message,
        data: null
      });
    }
  
    try {
      const { where, sort, select, skip, limit, count } = options;
  
      if (count) {
        const total = await Task.countDocuments(where);
  
        return res.status(200).json({
          message: "OK",
          data: total
        });
      }
  
      const tasks = await Task.find(where)
        .sort(sort)
        .select(select)
        .skip(skip)
        .limit(limit)
        .exec();
  
      return res.status(200).json({
        message: "OK",
        data: tasks
      });
  
    } catch (err) {
      console.error("GET /api/tasks:", err);
  
      const status = isInvalidQueryError(err) ? 400 : 500;
  
      return res.status(status).json({
        message: status === 400
          ? "Invalid query parameters"
          : "Internal server error",
        data: null
      });
    }
  });

// GET /api/tasks/:id
router.get("/:id", async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(404).json({
        message: "Task not found",
        data: null
      });
    }
  
    let select;
  
    try {
      select = parseSelect(req.query.select);
    } catch (err) {
      return res.status(400).json({
        message: err.message,
        data: null
      });
    }
  
    try {
      const task = await Task.findById(req.params.id)
        .select(select)
        .exec();
  
      if (!task) {
        return res.status(404).json({
          message: "Task not found",
          data: null
        });
      }
  
      return res.status(200).json({
        message: "OK",
        data: task
      });
  
    } catch (err) {
      console.error("GET /api/tasks/:id:", err);
  
      return res.status(500).json({
        message: "Internal server error",
        data: null
      });
    }
  });


// POST /api/tasks

router.post("/", async (req, res) => {
  const validationError = validateTask(req.body);

  if (validationError) {
    return res.status(400).json({
      message: validationError,
      data: null
    });
  }

  const session = await mongoose.startSession();

  try {
    let createdTask;

    await session.withTransaction(async () => {
      const assignment = await resolveAssignment(req.body, session);

      const task = new Task({
        name: req.body.name,
        description: req.body.description ?? "",
        deadline: req.body.deadline,
        completed: req.body.completed ?? false,
        ...assignment
      });

      await task.save({ session });

      if (assignment.assignedUser && !task.completed) {
        const result = await User.updateOne(
          { _id: assignment.assignedUser },
          { $addToSet: { pendingTasks: task._id.toString() } },
          { session }
        );

        if (result.matchedCount !== 1) {
          throw new RequestError(404, "Assigned user not found");
        }
      }

      createdTask = task;
    });

    return res.status(201).json({
      message: "Task created successfully",
      data: createdTask
    });

  } catch (err) {
    console.error("POST /api/tasks:", err);

    const status = err instanceof RequestError
      ? err.status
      : err.name === "ValidationError" || err.name === "CastError"
        ? 400
        : 500;

    return res.status(status).json({
      message: status === 500 ? "Internal server error" :
        status === 400 && !(err instanceof RequestError)
          ? "Invalid task data"
          : err.message,
      data: null
    });

  } finally {
    await session.endSession();
  }
});

// PUT /api/tasks/:id
router.put("/:id", async (req, res) => {
    const id = req.params.id;
  
    if (!isValidId(id)) {
      return res.status(404).json({
        message: "Task not found",
        data: null
      });
    }
  
    const session = await mongoose.startSession();
  
    try {
      let updatedTask;
  
      await session.withTransaction(async () => {
        const task = await Task.findById(id).session(session);
  
        if (!task) {
          throw new RequestError(404, "Task not found");
        }
  
        const validationError = validateTask(req.body);
  
        if (validationError) {
          throw new RequestError(400, validationError);
        }
  
        const assignment = await resolveAssignment(req.body, session);
  
        const oldUserId = task.assignedUser;
        const newUserId = assignment.assignedUser;
        const taskId = task._id.toString();
  
        if (oldUserId) {
          await User.updateOne(
            { _id: oldUserId },
            { $pull: { pendingTasks: taskId } },
            { session }
          );
        }
  
        if (newUserId && req.body.completed !== true) {
          const result = await User.updateOne(
            { _id: newUserId },
            { $addToSet: { pendingTasks: taskId } },
            { session }
          );
  
          if (result.matchedCount !== 1) {
            throw new RequestError(404, "Assigned user not found");
          }
        }
  
        task.set({
          name: req.body.name,
          description: req.body.description ?? "",
          deadline: req.body.deadline,
          completed: req.body.completed ?? false,
          ...assignment
        });
  
        await task.save({ session });
  
        updatedTask = task;
      });
  
      return res.status(200).json({
        message: "Task updated successfully",
        data: updatedTask
      });
  
    } catch (err) {
      console.error("PUT /api/tasks/:id:", err);
  
      const status = err instanceof RequestError
        ? err.status
        : err.name === "ValidationError" || err.name === "CastError"
          ? 400
          : 500;
  
      return res.status(status).json({
        message: status === 500 ? "Internal server error" :
          status === 400 && !(err instanceof RequestError)
            ? "Invalid task data"
            : err.message,
        data: null
      });
  
    } finally {
      await session.endSession();
    }
  });

// DELETE /api/tasks/:id
router.delete("/:id", async (req, res) => {
    const id = req.params.id;
  
    if (!isValidId(id)) {
      return res.status(404).json({
        message: "Task not found",
        data: null
      });
    }
  
    let session;
  
    try {
      session = await mongoose.startSession();
      let deletedTask;
  
      await session.withTransaction(async () => {
        const task = await Task.findById(id).session(session);
  
        if (!task) {
          throw new RequestError(404, "Task not found");
        }
  
        const taskId = task._id.toString();
  
        if (task.assignedUser) {
          await User.updateOne(
            { _id: task.assignedUser },
            { $pull: { pendingTasks: taskId } },
            { session }
          );
        }
  
        await Task.deleteOne(
          { _id: task._id },
          { session }
        );
  
        deletedTask = task;
      });
  
      return res.status(200).json({
        message: "Task deleted successfully",
        data: deletedTask
      });
  
    } catch (err) {
      console.error("DELETE /api/tasks/:id:", err);
  
      if (err instanceof RequestError) {
        return res.status(err.status).json({
          message: err.message,
          data: null
        });
      }
  
      return res.status(500).json({
        message: "Internal server error",
        data: null
      });
  
    } finally {
      if (session) {
        await session.endSession();
      }
    }
  });

module.exports = router;
