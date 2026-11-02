const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/user");
const { validateUser, isValidId,  parseSelect, parseCollectionQuery } = require("../utils/validation");
const router = express.Router();
const Task = require("../models/task");

class RequestError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  
  async function syncPendingTasks(user, requestedIds, session) {
    const userId = user._id.toString();
    const newIds = requestedIds ?? [];
    const oldIds = (user.pendingTasks ?? []).map(String);
  
    if (new Set(newIds).size !== newIds.length) {
      throw new RequestError(400, "Duplicate task IDs");
    }
  
    if (!newIds.every(isValidId)) {
      throw new RequestError(400, "Invalid task ID");
    }
  
    const tasks = await Task.find({
      _id: { $in: newIds }
    }).session(session);
  
    if (tasks.length !== newIds.length) {
      throw new RequestError(404, "Referenced task not found");
    }
  
    if (tasks.some(task => task.completed)) {
      throw new RequestError(
        400,
        "Completed tasks cannot be pending"
      );
    }
  
    const newSet = new Set(newIds);
  
    for (const taskId of oldIds) {
      if (!newSet.has(taskId)) {
        await Task.updateOne(
          { _id: taskId, assignedUser: userId },
          {
            $set: {
              assignedUser: "",
              assignedUserName: "unassigned"
            }
          },
          { session }
        );
      }
    }
  
    for (const task of tasks) {
      const taskId = task._id.toString();
      const previousUserId = task.assignedUser;
  
      if (previousUserId && previousUserId !== userId) {
        await User.updateOne(
          { _id: previousUserId },
          { $pull: { pendingTasks: taskId } },
          { session }
        );
      }
  
      await Task.updateOne(
        { _id: task._id },
        {
          $set: {
            assignedUser: userId,
            assignedUserName: user.name
          }
        },
        { session }
      );
    }
  
    await Task.updateMany(
      { assignedUser: userId },
      { $set: { assignedUserName: user.name } },
      { session }
    );
  
    user.pendingTasks = newIds;
  }


// GET /api/users
router.get("/", async (req, res) => {
    let options;
  
    try {
      options = parseCollectionQuery(req.query, undefined);
    } catch (err) {
      return res.status(400).json({
        message: err.message,
        data: null
      });
    }
  
    try {
      const { where, sort, select, skip, limit, count } = options;
  
      if (count) {
        const total = await User.countDocuments(where);
  
        return res.status(200).json({
          message: "OK",
          data: total
        });
      }
  
      let query = User.find(where)
        .sort(sort)
        .select(select)
        .skip(skip);
  
      if (limit !== undefined) {
        query = query.limit(limit);
      }
  
      const users = await query.exec();
  
      return res.status(200).json({
        message: "OK",
        data: users
      });
  
    } catch (err) {
      console.error("GET /api/users:", err);
  
      const status = isInvalidQueryError(err) ? 400 : 500;
  
      return res.status(status).json({
        message: status === 400
          ? "Invalid query parameters"
          : "Internal server error",
        data: null
      });
    }
  });

// GET /api/users/:id
router.get("/:id", async (req, res) => {
    if (!isValidId(req.params.id)) {
      return res.status(404).json({
        message: "User not found",
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
      const user = await User.findById(req.params.id)
        .select(select)
        .exec();
  
      if (!user) {
        return res.status(404).json({
          message: "User not found",
          data: null
        });
      }
  
      return res.status(200).json({
        message: "OK",
        data: user
      });
  
    } catch (err) {
      console.error("GET /api/users/:id:", err);
  
      return res.status(500).json({
        message: "Internal server error",
        data: null
      });
    }
  });

// POST /api/users
router.post("/", async (req, res) => {
    const validationError = validateUser(req.body);
  
    if (validationError) {
      return res.status(400).json({
        message: validationError,
        data: null
      });
    }
  
    const session = await mongoose.startSession();
  
    try {
      let createdUser;
  
      await session.withTransaction(async () => {
        const duplicate = await User.exists({
          email: req.body.email
        }).session(session);
  
        if (duplicate) {
          throw new RequestError(400, "Email already exists");
        }
  
        const user = new User({
          name: req.body.name,
          email: req.body.email,
          pendingTasks: []
        });
  
        await user.save({ session });
  
        await syncPendingTasks(
          user,
          req.body.pendingTasks ?? [],
          session
        );
  
        await user.save({ session });
  
        createdUser = user;
      });
  
      return res.status(201).json({
        message: "User created successfully",
        data: createdUser
      });
  
    } catch (err) {
      console.error("POST /api/users:", err);
  
      const status = err instanceof RequestError
        ? err.status
        : err.code === 11000 ||
          err.name === "ValidationError" ||
          err.name === "CastError"
          ? 400
          : 500;
  
      const message = err instanceof RequestError
        ? err.message
        : err.code === 11000
          ? "Email already exists"
          : status === 400
            ? "Invalid user data"
            : "Internal server error";
  
      return res.status(status).json({
        message,
        data: null
      });
  
    } finally {
      await session.endSession();
    }
  });

// PUT /api/users/:id
router.put("/:id", async (req, res) => {
    const id = req.params.id;
  
    if (!isValidId(id)) {
      return res.status(404).json({
        message: "User not found",
        data: null
      });
    }
  
    const session = await mongoose.startSession();
  
    try {
      let updatedUser;
  
      await session.withTransaction(async () => {
        const user = await User.findById(id).session(session);
  
        if (!user) {
          throw new RequestError(404, "User not found");
        }
  
        const validationError = validateUser(req.body);
  
        if (validationError) {
          throw new RequestError(400, validationError);
        }
  
        const duplicate = await User.exists({
          email: req.body.email,
          _id: { $ne: id }
        }).session(session);
  
        if (duplicate) {
          throw new RequestError(400, "Email already exists");
        }
  
        user.name = req.body.name;
        user.email = req.body.email;
  
        await syncPendingTasks(
          user,
          req.body.pendingTasks ?? [],
          session
        );
  
        await user.save({ session });
  
        updatedUser = user;
      });
  
      return res.status(200).json({
        message: "User updated successfully",
        data: updatedUser
      });
  
    } catch (err) {
      console.error("PUT /api/users/:id:", err);
  
      const status = err instanceof RequestError
        ? err.status
        : err.code === 11000 ||
          err.name === "ValidationError" ||
          err.name === "CastError"
          ? 400
          : 500;
  
      const message = err instanceof RequestError
        ? err.message
        : err.code === 11000
          ? "Email already exists"
          : status === 400
            ? "Invalid user data"
            : "Internal server error";
  
      return res.status(status).json({
        message,
        data: null
      });
  
    } finally {
      await session.endSession();
    }
  });

// DELETE /api/users/:id
router.delete("/:id", async (req, res) => {
    const id = req.params.id;
  
    if (!isValidId(id)) {
      return res.status(404).json({
        message: "User not found",
        data: null
      });
    }
  
    let session;
  
    try {
      session = await mongoose.startSession();
      let deletedUser;
  
      await session.withTransaction(async () => {
        const user = await User.findById(id).session(session);
  
        if (!user) {
          throw new RequestError(404, "User not found");
        }
  
        await Task.updateMany(
          { assignedUser: id },
          {
            $set: {
              assignedUser: "",
              assignedUserName: "unassigned"
            }
          },
          { session }
        );
  
        await User.deleteOne(
          { _id: user._id },
          { session }
        );
  
        deletedUser = user;
      });
  
      return res.status(204).end();
  
    } catch (err) {
      console.error("DELETE /api/users/:id:", err);
  
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