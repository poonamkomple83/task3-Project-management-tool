const express = require("express");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// =========================
// MIDDLEWARE
// =========================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
    session({
        secret: "project-management-secret-key",
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 24 * 60 * 60 * 1000
        }
    })
);

app.use(express.static(path.join(__dirname, "public")));

// =========================
// DATABASE
// =========================

const db = new sqlite3.Database("./users.db", (err) => {
    if (err) {
        console.error("Database connection error:", err.message);
    } else {
        console.log("Connected to SQLite database.");
    }
});

// =========================
// USERS TABLE
// =========================

db.run(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`, (err) => {
    if (err) {
        console.error("Users table error:", err.message);
    } else {
        console.log("Users table ready.");
    }
});
// =========================
// ADD PROJECT MEMBER
// =========================

app.post("/api/projects/:id/members", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message: "Please login first."
        });
    }

    const projectId = req.params.id;
    const { user_id } = req.body;

    if (!user_id) {
        return res.status(400).json({
            success: false,
            message: "User ID is required."
        });
    }

    // Check whether logged-in user owns the project
    db.get(
        `
        SELECT id
        FROM projects
        WHERE id = ?
        AND owner_id = ?
        `,
        [
            projectId,
            req.session.userId
        ],
        (err, project) => {

            if (err) {
                console.error(
                    "Project check error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message: "Failed to check project."
                });
            }

            if (!project) {
                return res.status(403).json({
                    success: false,
                    message:
                        "Only the project owner can add members."
                });
            }

            // Check user exists
            db.get(
                `
                SELECT id, name, email
                FROM users
                WHERE id = ?
                `,
                [user_id],
                (err, user) => {

                    if (err) {
                        console.error(
                            "User check error:",
                            err.message
                        );

                        return res.status(500).json({
                            success: false,
                            message: "Failed to check user."
                        });
                    }

                    if (!user) {
                        return res.status(404).json({
                            success: false,
                            message: "User not found."
                        });
                    }

                    // Add member
                    db.run(
                        `
                        INSERT INTO project_members
                        (project_id, user_id)
                        VALUES (?, ?)
                        `,
                        [
                            projectId,
                            user_id
                        ],
                        function (err) {

                            if (err) {

                                if (
                                    err.message.includes(
                                        "UNIQUE"
                                    )
                                ) {
                                    return res.status(400).json({
                                        success: false,
                                        message:
                                            "User is already a member of this project."
                                    });
                                }

                                console.error(
                                    "Add member error:",
                                    err.message
                                );

                                return res.status(500).json({
                                    success: false,
                                    message:
                                        "Failed to add member."
                                });
                            }

                            // Notification
                            const notificationMessage =
                                `You have been added to project ID ${projectId}.`;

                            db.run(
                                `
                                INSERT INTO notifications
                                (user_id, message)
                                VALUES (?, ?)
                                `,
                                [
                                    user_id,
                                    notificationMessage
                                ],
                                (notificationError) => {

                                    if (notificationError) {
                                        console.error(
                                            "Member notification error:",
                                            notificationError.message
                                        );
                                    }

                                    io.to(
                                        `user_${user_id}`
                                    ).emit(
                                        "new_notification",
                                        {
                                            message:
                                                notificationMessage
                                        }
                                    );
                                }
                            );

                            res.json({
                                success: true,
                                message:
                                    `${user.name} added to project successfully.`,
                                memberId: this.lastID
                            });
                        }
                    );
                }
            );
        }
    );
});

// =========================
// PROJECTS TABLE
// =========================

db.run(`
    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        owner_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id)
    )
`, (err) => {
    if (err) {
        console.error("Projects table error:", err.message);
    } else {
        console.log("Projects table ready.");
    }
});

// =========================
// PROJECT MEMBERS TABLE
// =========================

db.run(`
    CREATE TABLE IF NOT EXISTS project_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`, (err) => {
    if (err) {
        console.error(
            "Project members table error:",
            err.message
        );
    } else {
        console.log("Project members table ready.");
    }
});

// =========================
// TASKS TABLE
// =========================

db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        assigned_to INTEGER,
        priority TEXT DEFAULT 'Medium',
        status TEXT DEFAULT 'todo',
        due_date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (assigned_to) REFERENCES users(id)
    )
`, (err) => {
    if (err) {
        console.error("Tasks table error:", err.message);
    } else {
        console.log("Tasks table ready.");
    }
});

// =========================
// COMMENTS TABLE
// =========================

db.run(`
    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        comment TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`, (err) => {
    if (err) {
        console.error("Comments table error:", err.message);
    } else {
        console.log("Comments table ready.");
    }
});

// =========================
// NOTIFICATIONS TABLE
// =========================

db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`, (err) => {
    if (err) {
        console.error(
            "Notifications table error:",
            err.message
        );
    } else {
        console.log("Notifications table ready.");
    }
});

// =========================
// PASSWORD FUNCTIONS
// =========================

function hashPassword(password) {
    const salt = crypto
        .randomBytes(16)
        .toString("hex");

    const hash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
    const parts = storedPassword.split(":");

    if (parts.length !== 2) {
        return false;
    }

    const salt = parts[0];
    const storedHash = parts[1];

    const hash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return crypto.timingSafeEqual(
        Buffer.from(hash, "hex"),
        Buffer.from(storedHash, "hex")
    );
}

// =========================
// HTML ROUTES
// =========================

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});

app.get("/login", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "login.html")
    );
});

app.get("/register", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "register.html")
    );
});

// =========================
// REGISTER
// =========================

app.post("/api/register", (req, res) => {

    const {
        name,
        email,
        password
    } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({
            success: false,
            message: "All fields are required."
        });
    }

    const hashedPassword = hashPassword(password);

    db.run(
        `
        INSERT INTO users
        (name, email, password)
        VALUES (?, ?, ?)
        `,
        [
            name.trim(),
            email.trim().toLowerCase(),
            hashedPassword
        ],
        function (err) {

            if (err) {

                if (err.message.includes("UNIQUE")) {
                    return res.status(400).json({
                        success: false,
                        message:
                            "Email already registered."
                    });
                }

                console.error(
                    "Registration error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Registration failed."
                });
            }

            res.json({
                success: true,
                message:
                    "Registration successful.",
                userId: this.lastID
            });
        }
    );
});

// =========================
// LOGIN
// =========================

app.post("/api/login", (req, res) => {

    const {
        email,
        password
    } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message:
                "Email and password are required."
        });
    }

    db.get(
        `
        SELECT *
        FROM users
        WHERE email = ?
        `,
        [
            email.trim().toLowerCase()
        ],
        (err, user) => {

            if (err) {
                console.error(
                    "Login error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Login failed."
                });
            }

            if (!user) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid email or password."
                });
            }

            const validPassword =
                verifyPassword(
                    password,
                    user.password
                );

            if (!validPassword) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Invalid email or password."
                });
            }

            req.session.userId = user.id;

            res.json({
                success: true,
                message:
                    "Login successful.",
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email
                }
            });
        }
    );
});

// =========================
// CURRENT USER
// =========================

app.get("/api/me", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Not logged in."
        });
    }

    db.get(
        `
        SELECT id, name, email
        FROM users
        WHERE id = ?
        `,
        [
            req.session.userId
        ],
        (err, user) => {

            if (err) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to get user."
                });
            }

            if (!user) {
                return res.status(404).json({
                    success: false,
                    message:
                        "User not found."
                });
            }

            res.json({
                success: true,
                user: user
            });
        }
    );
});

// =========================
// LOGOUT
// =========================

app.post("/api/logout", (req, res) => {

    req.session.destroy((err) => {

        if (err) {
            return res.status(500).json({
                success: false,
                message:
                    "Logout failed."
            });
        }

        res.json({
            success: true,
            message:
                "Logged out successfully."
        });
    });
});

// =========================
// CREATE PROJECT
// =========================

app.post("/api/projects", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    const {
        name,
        description
    } = req.body;

    if (!name || !name.trim()) {
        return res.status(400).json({
            success: false,
            message:
                "Project name is required."
        });
    }

    db.run(
        `
        INSERT INTO projects
        (name, description, owner_id)
        VALUES (?, ?, ?)
        `,
        [
            name.trim(),
            description || "",
            req.session.userId
        ],
        function (err) {

            if (err) {
                console.error(
                    "Project creation error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to create project."
                });
            }

            const projectId = this.lastID;

            // Add creator as project member
            db.run(
                `
                INSERT OR IGNORE INTO project_members
                (project_id, user_id)
                VALUES (?, ?)
                `,
                [
                    projectId,
                    req.session.userId
                ],
                (memberError) => {

                    if (memberError) {
                        console.error(
                            "Project member error:",
                            memberError.message
                        );
                    }

                    res.json({
                        success: true,
                        message:
                            "Project created successfully.",
                        projectId:
                            projectId
                    });
                }
            );
        }
    );
});

// =========================
// GET PROJECTS
// =========================

app.get("/api/projects", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    db.all(
        `
        SELECT
            projects.id,
            projects.name,
            projects.description,
            projects.owner_id,
            projects.created_at,
            users.name AS owner_name
        FROM projects
        JOIN users
        ON projects.owner_id = users.id
        WHERE projects.owner_id = ?
        ORDER BY projects.created_at DESC
        `,
        [
            req.session.userId
        ],
        (err, projects) => {

            if (err) {
                console.error(
                    "Projects loading error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to load projects."
                });
            }

            res.json({
                success: true,
                projects: projects
            });
        }
    );
});

// =========================
// GET USERS
// =========================

app.get("/api/users", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    db.all(
        `
        SELECT id, name, email
        FROM users
        ORDER BY name ASC
        `,
        [],
        (err, users) => {

            if (err) {
                console.error(
                    "Users loading error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to load users."
                });
            }

            res.json({
                success: true,
                users: users
            });
        }
    );
});

// =========================
// ADD TASK
// =========================

app.post("/api/tasks", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    const {
        project_id,
        title,
        description,
        assigned_to,
        priority,
        due_date
    } = req.body;

    if (!project_id) {
        return res.status(400).json({
            success: false,
            message:
                "Project ID is required."
        });
    }

    if (!title || !title.trim()) {
        return res.status(400).json({
            success: false,
            message:
                "Task title is required."
        });
    }

    // Check project ownership
    db.get(
        `
        SELECT id
        FROM projects
        WHERE id = ?
        AND owner_id = ?
        `,
        [
            project_id,
            req.session.userId
        ],
        (err, project) => {

            if (err) {
                console.error(
                    "Project check error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to create task."
                });
            }

            if (!project) {
                return res.status(403).json({
                    success: false,
                    message:
                        "You do not have access to this project."
                });
            }

            db.run(
                `
                INSERT INTO tasks
                (
                    project_id,
                    title,
                    description,
                    assigned_to,
                    priority,
                    status,
                    due_date
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    project_id,
                    title.trim(),
                    description || "",
                    assigned_to || null,
                    priority || "Medium",
                    "todo",
                    due_date || null
                ],
                function (err) {

                    if (err) {
                        console.error(
                            "Task creation error:",
                            err.message
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Failed to create task."
                        });
                    }

                    const taskId =
                        this.lastID;

                    // Notification
                    if (assigned_to) {

                        const notificationMessage =
                            `You have been assigned a new task: ${title.trim()}`;

                        db.run(
                            `
                            INSERT INTO notifications
                            (user_id, message)
                            VALUES (?, ?)
                            `,
                            [
                                assigned_to,
                                notificationMessage
                            ],
                            (notificationError) => {

                                if (notificationError) {
                                    console.error(
                                        "Notification error:",
                                        notificationError.message
                                    );
                                }

                                io.to(
                                    `user_${assigned_to}`
                                ).emit(
                                    "new_notification",
                                    {
                                        message:
                                            notificationMessage
                                    }
                                );
                            }
                        );
                    }

                    res.json({
                        success: true,
                        message:
                            "Task added successfully.",
                        taskId:
                            taskId
                    });
                }
            );
        }
    );
});

// =========================
// GET TASKS
// =========================

app.get("/api/tasks", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    const projectId =
        req.query.project_id;

    if (!projectId) {
        return res.status(400).json({
            success: false,
            message:
                "Project ID is required."
        });
    }

    db.get(
        `
        SELECT id
        FROM projects
        WHERE id = ?
        AND owner_id = ?
        `,
        [
            projectId,
            req.session.userId
        ],
        (err, project) => {

            if (err) {
                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to check project."
                });
            }

            if (!project) {
                return res.status(403).json({
                    success: false,
                    message:
                        "You do not have access to this project."
                });
            }

            db.all(
                `
                SELECT
                    tasks.id,
                    tasks.project_id,
                    tasks.title,
                    tasks.description,
                    tasks.assigned_to,
                    tasks.priority,
                    tasks.status,
                    tasks.due_date,
                    tasks.created_at,
                    users.name AS assigned_name,
                    users.email AS assigned_email
                FROM tasks
                LEFT JOIN users
                ON tasks.assigned_to = users.id
                WHERE tasks.project_id = ?
                ORDER BY tasks.created_at DESC
                `,
                [
                    projectId
                ],
                (err, tasks) => {

                    if (err) {
                        console.error(
                            "Tasks loading error:",
                            err.message
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Failed to load tasks."
                        });
                    }

                    res.json({
                        success: true,
                        tasks: tasks
                    });
                }
            );
        }
    );
});

// =========================
// UPDATE TASK STATUS
// =========================

app.put("/api/tasks/:id/status", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    const taskId =
        req.params.id;

    const {
        status
    } = req.body;

    const allowedStatuses = [
        "todo",
        "in_progress",
        "completed"
    ];

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message:
                "Invalid status."
        });
    }

    db.run(
        `
        UPDATE tasks
        SET status = ?
        WHERE id = ?
        AND project_id IN (
            SELECT id
            FROM projects
            WHERE owner_id = ?
        )
        `,
        [
            status,
            taskId,
            req.session.userId
        ],
        function (err) {

            if (err) {
                console.error(
                    "Status update error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to update status."
                });
            }

            if (this.changes === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Task not found."
                });
            }

            res.json({
                success: true,
                message:
                    "Task status updated."
            });
        }
    );
});

// =========================
// UPDATE TASK
// =========================

app.put("/api/tasks/:id", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    const taskId =
        req.params.id;

    const {
        title,
        description,
        assigned_to,
        priority,
        due_date
    } = req.body;

    if (!title || !title.trim()) {
        return res.status(400).json({
            success: false,
            message:
                "Task title is required."
        });
    }

    db.run(
        `
        UPDATE tasks
        SET
            title = ?,
            description = ?,
            assigned_to = ?,
            priority = ?,
            due_date = ?
        WHERE id = ?
        AND project_id IN (
            SELECT id
            FROM projects
            WHERE owner_id = ?
        )
        `,
        [
            title.trim(),
            description || "",
            assigned_to || null,
            priority || "Medium",
            due_date || null,
            taskId,
            req.session.userId
        ],
        function (err) {

            if (err) {
                console.error(
                    "Task update error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to update task."
                });
            }

            if (this.changes === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Task not found."
                });
            }

            res.json({
                success: true,
                message:
                    "Task updated successfully."
            });
        }
    );
});

// =========================
// DELETE TASK
// =========================

app.delete("/api/tasks/:id", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    const taskId =
        req.params.id;

    db.run(
        `
        DELETE FROM tasks
        WHERE id = ?
        AND project_id IN (
            SELECT id
            FROM projects
            WHERE owner_id = ?
        )
        `,
        [
            taskId,
            req.session.userId
        ],
        function (err) {

            if (err) {
                console.error(
                    "Task delete error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to delete task."
                });
            }

            if (this.changes === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Task not found."
                });
            }

            res.json({
                success: true,
                message:
                    "Task deleted successfully."
            });
        }
    );
});

// =========================
// ADD COMMENT
// =========================

app.post("/api/comments", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    const {
        task_id,
        comment
    } = req.body;

    if (!task_id) {
        return res.status(400).json({
            success: false,
            message:
                "Task ID is required."
        });
    }

    if (!comment || !comment.trim()) {
        return res.status(400).json({
            success: false,
            message:
                "Comment cannot be empty."
        });
    }

    db.get(
        `
        SELECT tasks.id
        FROM tasks
        JOIN projects
        ON tasks.project_id = projects.id
        WHERE tasks.id = ?
        AND projects.owner_id = ?
        `,
        [
            task_id,
            req.session.userId
        ],
        (err, task) => {

            if (err) {
                console.error(
                    "Task check error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to add comment."
                });
            }

            if (!task) {
                return res.status(403).json({
                    success: false,
                    message:
                        "You do not have access to this task."
                });
            }

            db.run(
                `
                INSERT INTO comments
                (task_id, user_id, comment)
                VALUES (?, ?, ?)
                `,
                [
                    task_id,
                    req.session.userId,
                    comment.trim()
                ],
                function (err) {

                    if (err) {
                        console.error(
                            "Comment creation error:",
                            err.message
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Failed to add comment."
                        });
                    }

                    res.json({
                        success: true,
                        message:
                            "Comment added successfully.",
                        commentId:
                            this.lastID
                    });
                }
            );
        }
    );
});

// =========================
// GET COMMENTS
// =========================

app.get("/api/comments", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    const taskId =
        req.query.task_id;

    if (!taskId) {
        return res.status(400).json({
            success: false,
            message:
                "Task ID is required."
        });
    }

    db.get(
        `
        SELECT tasks.id
        FROM tasks
        JOIN projects
        ON tasks.project_id = projects.id
        WHERE tasks.id = ?
        AND projects.owner_id = ?
        `,
        [
            taskId,
            req.session.userId
        ],
        (err, task) => {

            if (err) {
                console.error(
                    "Task check error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to load comments."
                });
            }

            if (!task) {
                return res.status(403).json({
                    success: false,
                    message:
                        "You do not have access to this task."
                });
            }

            db.all(
                `
                SELECT
                    comments.id,
                    comments.task_id,
                    comments.user_id,
                    comments.comment,
                    comments.created_at,
                    users.name AS user_name,
                    users.email AS user_email
                FROM comments
                JOIN users
                ON comments.user_id = users.id
                WHERE comments.task_id = ?
                ORDER BY comments.created_at ASC
                `,
                [
                    taskId
                ],
                (err, comments) => {

                    if (err) {
                        console.error(
                            "Error loading comments:",
                            err.message
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Failed to load comments."
                        });
                    }

                    res.json({
                        success: true,
                        comments:
                            comments
                    });
                }
            );
        }
    );
});

// =========================
// DELETE COMMENT
// =========================

app.delete("/api/comments/:id", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    const commentId =
        req.params.id;

    db.get(
        `
        SELECT id
        FROM comments
        WHERE id = ?
        AND user_id = ?
        `,
        [
            commentId,
            req.session.userId
        ],
        (err, comment) => {

            if (err) {
                console.error(
                    "Comment check error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to delete comment."
                });
            }

            if (!comment) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Comment not found or you do not have permission."
                });
            }

            db.run(
                `
                DELETE FROM comments
                WHERE id = ?
                `,
                [
                    commentId
                ],
                function (err) {

                    if (err) {
                        console.error(
                            "Delete comment error:",
                            err.message
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Failed to delete comment."
                        });
                    }

                    res.json({
                        success: true,
                        message:
                            "Comment deleted successfully."
                    });
                }
            );
        }
    );
});

// =========================
// NOTIFICATIONS
// =========================

app.get("/api/notifications", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message:
                "Please login first."
        });
    }

    db.all(
        `
        SELECT
            id,
            message,
            is_read,
            created_at
        FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        `,
        [
            req.session.userId
        ],
        (err, notifications) => {

            if (err) {
                console.error(
                    "Notification loading error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message:
                        "Failed to load notifications."
                });
            }

            res.json({
                success: true,
                notifications:
                    notifications
            });
        }
    );
});

// =========================
// MARK NOTIFICATION READ
// =========================

app.put(
    "/api/notifications/:id/read",
    (req, res) => {

        if (!req.session.userId) {
            return res.status(401).json({
                success: false,
                message:
                    "Please login first."
            });
        }

        const notificationId =
            req.params.id;

        db.run(
            `
            UPDATE notifications
            SET is_read = 1
            WHERE id = ?
            AND user_id = ?
            `,
            [
                notificationId,
                req.session.userId
            ],
            function (err) {

                if (err) {
                    console.error(
                        "Notification update error:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Failed to update notification."
                    });
                }

                res.json({
                    success: true,
                    message:
                        "Notification marked as read."
                });
            }
        );
    }
);

// =========================
// DELETE NOTIFICATION
// =========================

app.delete(
    "/api/notifications/:id",
    (req, res) => {

        if (!req.session.userId) {
            return res.status(401).json({
                success: false,
                message:
                    "Please login first."
            });
        }

        const notificationId =
            req.params.id;

        db.run(
            `
            DELETE FROM notifications
            WHERE id = ?
            AND user_id = ?
            `,
            [
                notificationId,
                req.session.userId
            ],
            function (err) {

                if (err) {
                    console.error(
                        "Notification delete error:",
                        err.message
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            "Failed to delete notification."
                    });
                }

                res.json({
                    success: true,
                    message:
                        "Notification deleted successfully."
                });
            }
        );
    }
);
// =========================
// PROJECT MEMBERS TABLE
// =========================

db.run(`
    CREATE TABLE IF NOT EXISTS project_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`, (err) => {
    if (err) {
        console.error(
            "Project members table error:",
            err.message
        );
    } else {
        console.log(
            "Project members table ready."
        );
    }
});
// =========================
// GET PROJECT MEMBERS
// =========================

app.get("/api/projects/:id/members", (req, res) => {

    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message: "Please login first."
        });
    }

    const projectId = req.params.id;

    db.get(
        `
        SELECT id
        FROM projects
        WHERE id = ?
        AND owner_id = ?
        `,
        [
            projectId,
            req.session.userId
        ],
        (err, project) => {

            if (err) {
                console.error(
                    "Project check error:",
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    message: "Failed to check project."
                });
            }

            if (!project) {
                return res.status(403).json({
                    success: false,
                    message:
                        "You do not have access to this project."
                });
            }

            db.all(
                `
                SELECT
                    project_members.id AS member_id,
                    users.id AS user_id,
                    users.name,
                    users.email,
                    project_members.created_at
                FROM project_members
                JOIN users
                ON project_members.user_id = users.id
                WHERE project_members.project_id = ?
                ORDER BY project_members.created_at ASC
                `,
                [projectId],
                (err, members) => {

                    if (err) {
                        console.error(
                            "Members loading error:",
                            err.message
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Failed to load team members."
                        });
                    }

                    res.json({
                        success: true,
                        members: members
                    });
                }
            );
        }
    );
});
// =========================
// SOCKET.IO
// =========================

io.on("connection", (socket) => {

    console.log(
        "User connected:",
        socket.id
    );

    socket.on(
        "join_user",
        (userId) => {

            if (userId) {

                socket.join(
                    `user_${userId}`
                );

                console.log(
                    `User ${userId} joined notification room.`
                );
            }
        }
    );

    socket.on(
        "disconnect",
        () => {

            console.log(
                "User disconnected:",
                socket.id
            );
        }
    );
});

// =========================
// START SERVER
// =========================

server.listen(PORT, () => {

    console.log(
        `Server running at http://localhost:${PORT}`
    );

});