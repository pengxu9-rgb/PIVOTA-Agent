import pytest
from fastapi import BackgroundTasks

from routes import agent_shop_gateway


@pytest.mark.asyncio
async def test_invoke_shop_operation_proxies_beauty_find_products_multi(monkeypatch):
    captured = {}

    async def fake_proxy_public_shop_invoke(request_body):
        captured["request_body"] = request_body
        return {
            "status": "success",
            "metadata": {
                "resolved_contract": "agent_v1_search_beauty_mainline",
                "decision_owner": "shopping_agent_beauty_mainline",
                "semantic_owner": "shopping_agent_beauty_mainline",
                "mainline_status": "grounded_success",
                "selected_product_ids": ["sku-1"],
            },
            "products": [{"id": "sku-1", "title": "Demo Product"}],
            "reply": "To avoid off-topic recommendations, what should we prioritize?\n1) Brand lookup",
        }

    async def fail_local_handler(*args, **kwargs):
        raise AssertionError("beauty find_products_multi should not hit local legacy handler")

    monkeypatch.setattr(agent_shop_gateway, "_proxy_public_shop_invoke", fake_proxy_public_shop_invoke)
    monkeypatch.setattr(agent_shop_gateway, "_handle_find_products_multi", fail_local_handler)

    request = agent_shop_gateway.ShopGatewayRequest(
        operation="find_products_multi",
        payload={
            "search": {
                "query": "best sunscreen for oily skin",
                "catalog_surface": "beauty",
            }
        },
        metadata={
            "source": "aurora-bff",
            "catalog_surface": "beauty",
        },
    )

    result = await agent_shop_gateway.invoke_shop_operation(request, BackgroundTasks())

    assert captured["request_body"]["operation"] == "find_products_multi"
    assert captured["request_body"]["payload"]["search"]["catalog_surface"] == "beauty"
    assert result["metadata"]["resolved_contract"] == "agent_v1_search_beauty_mainline"
    assert result["reply"] is None


@pytest.mark.asyncio
async def test_proxy_public_shop_invoke_keeps_reply_for_non_grounded_beauty_result(monkeypatch):
    class FakeResponse:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {
                "products": [],
                "reply": "Need more detail before I can recommend anything.",
                "metadata": {
                    "resolved_contract": "agent_v1_search_beauty_mainline",
                    "decision_owner": "shopping_agent_beauty_mainline",
                    "semantic_owner": "shopping_agent_beauty_mainline",
                    "mainline_status": "empty",
                },
            }

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, json, headers):
            return FakeResponse()

    monkeypatch.setattr(agent_shop_gateway.httpx, "AsyncClient", lambda timeout=25.0: FakeClient())

    result = await agent_shop_gateway._proxy_public_shop_invoke(
        {
            "operation": "find_products_multi",
            "payload": {
                "search": {
                    "query": "best sunscreen for oily skin",
                    "catalog_surface": "beauty",
                }
            },
            "metadata": {
                "source": "shopping-agent-ui",
                "catalog_surface": "beauty",
            },
        }
    )

    assert result["reply"] == "Need more detail before I can recommend anything."


@pytest.mark.asyncio
async def test_invoke_shop_operation_keeps_non_beauty_find_products_multi_local(monkeypatch):
    captured = {}

    async def fake_proxy_public_shop_invoke(request_body):
        raise AssertionError("non-beauty find_products_multi should not proxy to beauty mainline")

    async def fake_local_handler(payload, request_metadata, background_tasks):
        captured["query"] = payload.search.query
        captured["metadata"] = request_metadata
        return {"status": "success", "metadata": {"query_source": "cache_multi_intent"}}

    monkeypatch.setattr(agent_shop_gateway, "_proxy_public_shop_invoke", fake_proxy_public_shop_invoke)
    monkeypatch.setattr(agent_shop_gateway, "_handle_find_products_multi", fake_local_handler)

    request = agent_shop_gateway.ShopGatewayRequest(
        operation="find_products_multi",
        payload={
            "search": {
                "query": "red shirt",
            }
        },
        metadata={
            "source": "creator-agent-ui",
        },
    )

    result = await agent_shop_gateway.invoke_shop_operation(request, BackgroundTasks())

    assert captured["query"] == "red shirt"
    assert result["metadata"]["query_source"] == "cache_multi_intent"
