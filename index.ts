#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runAppleScript } from "run-applescript";
import tools from "./tools";


// Safe mode implementation - lazy loading of modules
let useEagerLoading = true;
let loadingTimeout: ReturnType<typeof setTimeout> | null = null;
let safeModeFallback = false;

console.error("Starting apple-mcp server...");

// Placeholders for modules - will either be loaded eagerly or lazily
let contacts: typeof import("./utils/contacts").default | null = null;
let message: typeof import("./utils/message").default | null = null;
let reminders: typeof import("./utils/reminders").default | null = null;

// Type map for module names to their types
type ModuleMap = {
	contacts: typeof import("./utils/contacts").default;
	message: typeof import("./utils/message").default;
	reminders: typeof import("./utils/reminders").default;
};

// Helper function for lazy module loading
async function loadModule<
	T extends "contacts" | "message" | "reminders",
>(moduleName: T): Promise<ModuleMap[T]> {
	if (safeModeFallback) {
		console.error(`Loading ${moduleName} module on demand (safe mode)...`);
	}

	try {
		switch (moduleName) {
			case "contacts":
				if (!contacts) contacts = (await import("./utils/contacts")).default;
				return contacts as ModuleMap[T];
			case "message":
				if (!message) message = (await import("./utils/message")).default;
				return message as ModuleMap[T];
			case "reminders":
				if (!reminders) reminders = (await import("./utils/reminders")).default;
				return reminders as ModuleMap[T];
			default:
				throw new Error(`Unknown module: ${moduleName}`);
		}
	} catch (e) {
		console.error(`Error loading module ${moduleName}:`, e);
		throw e;
	}
}

// Set a timeout to switch to safe mode if initialization takes too long
loadingTimeout = setTimeout(() => {
	console.error(
		"Loading timeout reached. Switching to safe mode (lazy loading...)",
	);
	useEagerLoading = false;
	safeModeFallback = true;

	// Clear the references to any modules that might be in a bad state
	contacts = null;
	message = null;
	reminders = null;

	// Proceed with server setup
	initServer();
}, 5000); // 5 second timeout

// Eager loading attempt
async function attemptEagerLoading() {
	try {
		console.error("Attempting to eagerly load modules...");

		// Try to import all modules
		contacts = (await import("./utils/contacts")).default;
		console.error("- Contacts module loaded successfully");

		message = (await import("./utils/message")).default;
		console.error("- Message module loaded successfully");

		reminders = (await import("./utils/reminders")).default;
		console.error("- Reminders module loaded successfully");

		// If we get here, clear the timeout and proceed with eager loading
		if (loadingTimeout) {
			clearTimeout(loadingTimeout);
			loadingTimeout = null;
		}

		console.error("All modules loaded successfully, using eager loading mode");
		initServer();
	} catch (error) {
		console.error("Error during eager loading:", error);
		console.error("Switching to safe mode (lazy loading)...");

		// Clear any timeout if it exists
		if (loadingTimeout) {
			clearTimeout(loadingTimeout);
			loadingTimeout = null;
		}

		// Switch to safe mode
		useEagerLoading = false;
		safeModeFallback = true;

		// Clear the references to any modules that might be in a bad state
		contacts = null;
		message = null;
		reminders = null;

		// Initialize the server in safe mode
		initServer();
	}
}

// Attempt eager loading first
attemptEagerLoading();

// Main server object
let server: Server;

// Initialize the server and set up handlers
function initServer() {
	console.error(
		`Initializing server in ${safeModeFallback ? "safe" : "standard"} mode...`,
	);

	server = new Server(
		{
			name: "nora-apple-mcp",
			version: "1.0.0",
		},
		{
			capabilities: {
				tools: {},
			},
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools,
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		try {
			const { name, arguments: args } = request.params;

			if (!args) {
				throw new Error("No arguments provided");
			}

			switch (name) {
				case "contacts": {
					if (!isContactsArgs(args)) {
						throw new Error("Invalid arguments for contacts tool");
					}

					try {
						const contactsModule = await loadModule("contacts");

						if (args.name) {
							const numbers = await contactsModule.findNumber(args.name);
							return {
								content: [
									{
										type: "text",
										text: numbers.length
											? `${args.name}: ${numbers.join(", ")}`
											: `No contact found for "${args.name}". Try a different name or use no name parameter to list all contacts.`,
									},
								],
								isError: false,
							};
						} else {
							const allNumbers = await contactsModule.getAllNumbers();
							const contactCount = Object.keys(allNumbers).length;

							if (contactCount === 0) {
								return {
									content: [
										{
											type: "text",
											text: "No contacts found in the address book. Please make sure you have granted access to Contacts.",
										},
									],
									isError: false,
								};
							}

							const formattedContacts = Object.entries(allNumbers)
								.filter(([_, phones]) => phones.length > 0)
								.map(([name, phones]) => `${name}: ${phones.join(", ")}`);

							return {
								content: [
									{
										type: "text",
										text:
											formattedContacts.length > 0
												? `Found ${contactCount} contacts:\n\n${formattedContacts.join("\n")}`
												: "Found contacts but none have phone numbers. Try searching by name to see more details.",
									},
								],
								isError: false,
							};
						}
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						return {
							content: [
								{
									type: "text",
									text: errorMessage.includes("access") ? errorMessage : `Error accessing contacts: ${errorMessage}`,
								},
							],
							isError: true,
						};
					}
				}

				case "messages": {
					if (!isMessagesArgs(args)) {
						throw new Error("Invalid arguments for messages tool");
					}

					try {
						const messageModule = await loadModule("message");

						switch (args.operation) {
							case "send": {
								if (!args.phoneNumber || !args.message) {
									throw new Error(
										"Phone number and message are required for send operation",
									);
								}
								await messageModule.sendMessage(args.phoneNumber, args.message);
								return {
									content: [
										{
											type: "text",
											text: `Message sent to ${args.phoneNumber}`,
										},
									],
									isError: false,
								};
							}

							case "read": {
								if (!args.phoneNumber) {
									throw new Error(
										"Phone number is required for read operation",
									);
								}
								const messages = await messageModule.readMessages(
									args.phoneNumber,
									args.limit,
								);
								return {
									content: [
										{
											type: "text",
											text:
												messages.length > 0
													? messages
															.map(
																(msg) =>
																	`[${new Date(msg.date).toLocaleString()}] ${msg.is_from_me ? "Me" : msg.sender}: ${msg.content}`,
															)
															.join("\n")
													: "No messages found",
										},
									],
									isError: false,
								};
							}

							case "schedule": {
								if (!args.phoneNumber || !args.message || !args.scheduledTime) {
									throw new Error(
										"Phone number, message, and scheduled time are required for schedule operation",
									);
								}
								const scheduledMsg = await messageModule.scheduleMessage(
									args.phoneNumber,
									args.message,
									new Date(args.scheduledTime),
								);
								return {
									content: [
										{
											type: "text",
											text: `Message scheduled to be sent to ${args.phoneNumber} at ${scheduledMsg.scheduledTime}`,
										},
									],
									isError: false,
								};
							}

							case "unread": {
								const messages = await messageModule.getUnreadMessages(
									args.limit,
								);

								// Look up contact names for all messages
								const contactsModule = await loadModule("contacts");
								const messagesWithNames = await Promise.all(
									messages.map(async (msg) => {
										// Only look up names for messages not from me
										if (!msg.is_from_me) {
											const contactName =
												await contactsModule.findContactByPhone(msg.sender);
											return {
												...msg,
												displayName: contactName || msg.sender, // Use contact name if found, otherwise use phone/email
											};
										}
										return {
											...msg,
											displayName: "Me",
										};
									}),
								);

								return {
									content: [
										{
											type: "text",
											text:
												messagesWithNames.length > 0
													? `Found ${messagesWithNames.length} unread message(s):\n` +
														messagesWithNames
															.map(
																(msg) =>
																	`[${new Date(msg.date).toLocaleString()}] From ${msg.displayName}:\n${msg.content}`,
															)
															.join("\n\n")
													: "No unread messages found",
										},
									],
									isError: false,
								};
							}

							default:
								throw new Error(`Unknown operation: ${args.operation}`);
						}
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						return {
							content: [
								{
									type: "text",
									text: errorMessage.includes("access") ? errorMessage : `Error with messages operation: ${errorMessage}`,
								},
							],
							isError: true,
						};
					}
				}
				case "reminders": {
					if (!isRemindersArgs(args)) {
						throw new Error("Invalid arguments for reminders tool");
					}

					try {
						const remindersModule = await loadModule("reminders");

						const { operation } = args;

						if (operation === "list") {
							// List all reminders
							const lists = await remindersModule.getAllLists();
							const allReminders = await remindersModule.getAllReminders();
							return {
								content: [
									{
										type: "text",
										text: `Found ${lists.length} lists and ${allReminders.length} reminders.`,
									},
								],
								lists,
								reminders: allReminders,
								isError: false,
							};
						} else if (operation === "search") {
							// Search for reminders
							const { searchText } = args;
							const results = await remindersModule.searchReminders(
								searchText!,
							);
							return {
								content: [
									{
										type: "text",
										text:
											results.length > 0
												? `Found ${results.length} reminders matching "${searchText}".`
												: `No reminders found matching "${searchText}".`,
									},
								],
								reminders: results,
								isError: false,
							};
						} else if (operation === "open") {
							// Open a reminder
							const { searchText } = args;
							const result = await remindersModule.openReminder(searchText!);
							return {
								content: [
									{
										type: "text",
										text: result.success
											? `Opened Reminders app. Found reminder: ${result.reminder?.name}`
											: result.message,
									},
								],
								...result,
								isError: !result.success,
							};
						} else if (operation === "create") {
							// Create a reminder
							const { name, listName, notes, dueDate } = args;
							const result = await remindersModule.createReminder(
								name!,
								listName,
								notes,
								dueDate,
							);
							return {
								content: [
									{
										type: "text",
										text: `Created reminder "${result.name}" ${listName ? `in list "${listName}"` : ""}.`,
									},
								],
								success: true,
								reminder: result,
								isError: false,
							};
						} else if (operation === "listById") {
							// Get reminders from a specific list by ID
							const { listId, props } = args;
							const results = await remindersModule.getRemindersFromListById(
								listId!,
								props,
							);
							return {
								content: [
									{
										type: "text",
										text:
											results.length > 0
												? `Found ${results.length} reminders in list with ID "${listId}".`
												: `No reminders found in list with ID "${listId}".`,
									},
								],
								reminders: results,
								isError: false,
							};
						}

						return {
							content: [
								{
									type: "text",
									text: "Unknown operation",
								},
							],
							isError: true,
						};
					} catch (error) {
						console.error("Error in reminders tool:", error);
						const errorMessage = error instanceof Error ? error.message : String(error);
						return {
							content: [
								{
									type: "text",
									text: errorMessage.includes("access") ? errorMessage : `Error in reminders tool: ${errorMessage}`,
								},
							],
							isError: true,
						};
					}
				}
				default:
					return {
						content: [{ type: "text", text: `Unknown tool: ${name}` }],
						isError: true,
					};
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `Error: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				isError: true,
			};
		}
	});

	// Start the server transport
	console.error("Setting up MCP server transport...");

	(async () => {
		try {
			console.error("Initializing transport...");
			const transport = new StdioServerTransport();

			// Ensure stdout is only used for JSON messages
			console.error("Setting up stdout filter...");
			const originalStdoutWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
				// Only allow JSON messages to pass through
				if (typeof chunk === "string" && !chunk.startsWith("{")) {
					console.error("Filtering non-JSON stdout message");
					return true; // Silently skip non-JSON messages
				}
				return originalStdoutWrite(chunk, encoding, callback);
			};

			console.error("Connecting transport to server...");
			await server.connect(transport);
			console.error("Server connected successfully!");
		} catch (error) {
			console.error("Failed to initialize MCP server:", error);
			process.exit(1);
		}
	})();
}

// Helper functions for argument type checking
function isContactsArgs(args: unknown): args is { name?: string } {
	return (
		typeof args === "object" &&
		args !== null &&
		(!("name" in args) || typeof (args as { name: string }).name === "string")
	);
}
function isMessagesArgs(args: unknown): args is {
	operation: "send" | "read" | "schedule" | "unread";
	phoneNumber?: string;
	message?: string;
	limit?: number;
	scheduledTime?: string;
} {
	if (typeof args !== "object" || args === null) return false;

	const { operation, phoneNumber, message, limit, scheduledTime } = args as any;

	if (
		!operation ||
		!["send", "read", "schedule", "unread"].includes(operation)
	) {
		return false;
	}

	// Validate required fields based on operation
	switch (operation) {
		case "send":
		case "schedule":
			if (!phoneNumber || !message) return false;
			if (operation === "schedule" && !scheduledTime) return false;
			break;
		case "read":
			if (!phoneNumber) return false;
			break;
		case "unread":
			// No additional required fields
			break;
	}

	// Validate field types if present
	if (phoneNumber && typeof phoneNumber !== "string") return false;
	if (message && typeof message !== "string") return false;
	if (limit && typeof limit !== "number") return false;
	if (scheduledTime && typeof scheduledTime !== "string") return false;

	return true;
}
function isRemindersArgs(args: unknown): args is {
	operation: "list" | "search" | "open" | "create" | "listById";
	searchText?: string;
	name?: string;
	listName?: string;
	listId?: string;
	props?: string[];
	notes?: string;
	dueDate?: string;
} {
	if (typeof args !== "object" || args === null) {
		return false;
	}

	const { operation } = args as any;
	if (typeof operation !== "string") {
		return false;
	}

	if (!["list", "search", "open", "create", "listById"].includes(operation)) {
		return false;
	}

	// For search and open operations, searchText is required
	if (
		(operation === "search" || operation === "open") &&
		(typeof (args as any).searchText !== "string" ||
			(args as any).searchText === "")
	) {
		return false;
	}

	// For create operation, name is required
	if (
		operation === "create" &&
		(typeof (args as any).name !== "string" || (args as any).name === "")
	) {
		return false;
	}

	// For listById operation, listId is required
	if (
		operation === "listById" &&
		(typeof (args as any).listId !== "string" || (args as any).listId === "")
	) {
		return false;
	}

	return true;
}
