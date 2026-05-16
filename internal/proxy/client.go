package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Branch struct {
	ID           int    `json:"id"`
	Slug         string `json:"slug"`
	Status       string `json:"status"`
	ProxyPort    int    `json:"proxyPort"`
	BackendPort  int    `json:"backendPort"`
	LastActiveAt string `json:"lastActiveAt"`
}

type APIClient struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewAPIClient(baseURL string, token string) *APIClient {
	return &APIClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http: &http.Client{
			Timeout: 2 * time.Minute,
		},
	}
}

func (client *APIClient) ListBranches(ctx context.Context) ([]Branch, error) {
	var response struct {
		Branches []Branch `json:"branches"`
	}

	if err := client.request(ctx, http.MethodGet, "/proxy/branches", nil, &response); err != nil {
		return nil, err
	}

	return response.Branches, nil
}

func (client *APIClient) StartBranch(ctx context.Context, branchID int) (int, error) {
	var response struct {
		BackendPort int `json:"backendPort"`
	}

	if err := client.request(ctx, http.MethodPost, fmt.Sprintf("/branches/%d/start", branchID), nil, &response); err != nil {
		return 0, err
	}

	if response.BackendPort == 0 {
		return 0, fmt.Errorf("branch %d returned empty backend port", branchID)
	}

	return response.BackendPort, nil
}

func (client *APIClient) StopBranch(ctx context.Context, branchID int) error {
	return client.request(ctx, http.MethodPost, fmt.Sprintf("/branches/%d/stop", branchID), nil, nil)
}

func (client *APIClient) TouchBranch(ctx context.Context, branchID int) error {
	return client.request(ctx, http.MethodPost, fmt.Sprintf("/branches/%d/touch", branchID), nil, nil)
}

func (client *APIClient) request(ctx context.Context, method string, path string, input any, output any) error {
	var body *bytes.Reader

	if input == nil {
		body = bytes.NewReader(nil)
	} else {
		payload, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(payload)
	}

	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+path, body)
	if err != nil {
		return err
	}

	request.Header.Set("authorization", "Bearer "+client.token)
	request.Header.Set("content-type", "application/json")

	response, err := client.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var errorResponse struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(response.Body).Decode(&errorResponse)
		if errorResponse.Error != "" {
			return fmt.Errorf("%s %s: %s", method, path, errorResponse.Error)
		}
		return fmt.Errorf("%s %s: HTTP %d", method, path, response.StatusCode)
	}

	if output == nil {
		return nil
	}

	return json.NewDecoder(response.Body).Decode(output)
}
